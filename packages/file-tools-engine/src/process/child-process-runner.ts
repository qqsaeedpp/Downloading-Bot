import { spawn } from 'node:child_process';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';

/**
 * The one place an external binary is executed.
 *
 * `spawn` with an argument ARRAY and `shell: false`, never a command string.
 * Every input here — a filename, a page range, a bitrate — began life in a
 * Telegram message, and a shell string is the difference between an argument
 * containing a semicolon and a second command running as the worker user.
 *
 * There is no option to opt out of that. A runner that could be handed a string
 * would eventually be handed one.
 */

export interface ProcessRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * The job's own workspace. Also the process's working directory, so a
   * relative path a tool decides to write lands inside the sandbox rather than
   * wherever the worker happens to have been started.
   */
  readonly cwd: string;
  readonly timeoutMs: number;
  /**
   * Ceiling on captured stdout+stderr.
   *
   * ffmpeg on a corrupt input can emit megabytes of repeated warnings. Without
   * a bound, one bad file turns into an out-of-memory kill of the whole worker.
   */
  readonly maxOutputBytes?: number;
  /** User cancellation. Distinct from the timeout, and reported differently. */
  readonly signal?: AbortSignal | undefined;
  /** Called per chunk, for progress parsing. Receives text, not bytes. */
  readonly onStdout?: ((chunk: string) => void) | undefined;
  readonly onStderr?: ((chunk: string) => void) | undefined;
}

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when output hit `maxOutputBytes`; what is here is a prefix. */
  readonly truncated: boolean;
}

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** Collects output up to a ceiling, then keeps counting but stops storing. */
class BoundedBuffer {
  #chunks: string[] = [];
  #bytes = 0;
  #truncated = false;

  constructor(private readonly limit: number) {}

  push(text: string): void {
    if (this.#truncated) return;
    const size = Buffer.byteLength(text, 'utf8');
    if (this.#bytes + size > this.limit) {
      this.#truncated = true;
      // Keep the prefix that fits — the first lines of a tool's output are
      // almost always the ones that say what went wrong.
      this.#chunks.push(text.slice(0, Math.max(0, this.limit - this.#bytes)));
      this.#bytes = this.limit;
      return;
    }
    this.#chunks.push(text);
    this.#bytes += size;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  toString(): string {
    const joined = this.#chunks.join('');
    return this.#truncated ? `${joined}\n…[output truncated]` : joined;
  }
}

/**
 * Run a binary to completion.
 *
 * Resolves for ANY exit — including a non-zero one — so the caller can decide
 * what a given code means for a given tool. It throws only when the process
 * could not be run at all, or was stopped by us.
 */
export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new BoundedBuffer(limit);
  const stderr = new BoundedBuffer(limit);

  // Already cancelled before we spawned. Checked here so a cancel that lands
  // between queueing and starting does not pay for a process at all.
  if (options.signal?.aborted === true) {
    throw new ToolError(ToolErrorCode.ToolCancelled, `cancelled before ${options.command} started`);
  }

  const child = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    // Not negotiable; see the module comment.
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A process group, so a tool that forks — ffmpeg does — can be killed
    // whole. Killing only the parent leaves the children holding the workspace
    // open, which then cannot be deleted.
    detached: process.platform !== 'win32',
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  child.stdout.on('data', (chunk: string) => {
    stdout.push(chunk);
    options.onStdout?.(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    options.onStderr?.(chunk);
  });

  let outcome: 'timeout' | 'cancelled' | undefined;

  const stop = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      // Negative pid addresses the whole group. Windows has no groups, so the
      // child is killed directly and `taskkill` semantics apply.
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone between the check and the signal. Nothing to do, and
      // throwing here would replace the real failure with a bookkeeping one.
    }
  };

  const timer = setTimeout(() => {
    outcome = 'timeout';
    stop();
  }, options.timeoutMs);

  const onAbort = (): void => {
    outcome = 'cancelled';
    stop();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        // A process killed by a signal reports code `null`. Reporting that as 0
        // would make a killed ffmpeg look like a success.
        resolve(code ?? (signal === null ? 1 : 137));
      });
    });

    if (outcome === 'cancelled') {
      throw new ToolError(ToolErrorCode.ToolCancelled, `${options.command} cancelled`);
    }
    if (outcome === 'timeout') {
      throw new ToolError(
        ToolErrorCode.ToolTimeout,
        `${options.command} exceeded ${String(options.timeoutMs)} ms`,
        { context: { command: options.command, timeoutMs: options.timeoutMs } },
      );
    }

    return {
      exitCode,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      durationMs: Date.now() - startedAt,
      truncated: stdout.truncated || stderr.truncated,
    };
  } catch (error: unknown) {
    if (error instanceof ToolError) throw error;
    // ENOENT here means the binary is not in the image at all, which is a
    // deployment fault and not something the user can act on.
    throw new ToolError(
      ToolErrorCode.ExternalToolFailed,
      `${options.command} could not be started`,
      { cause: error, context: { command: options.command } },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Run a binary and require success.
 *
 * The common case. `stderr` is attached to the error's CONTEXT rather than its
 * message so that it reaches the log without any chance of reaching a user.
 */
export async function runProcessOrThrow(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const result = await runProcess(options);
  if (result.exitCode !== 0) {
    throw new ToolError(
      ToolErrorCode.ExternalToolFailed,
      `${options.command} exited with ${String(result.exitCode)}`,
      {
        context: {
          command: options.command,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 2_000),
        },
      },
    );
  }
  return result;
}
