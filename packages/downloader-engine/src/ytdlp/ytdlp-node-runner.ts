import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DownloadProgress, Logger } from '@tgtools/shared';
import { describeError, redactUrl, toAbortError } from '@tgtools/shared';
import { YtDlp } from 'ytdlp-nodejs';
import type { VideoProgress } from 'ytdlp-nodejs';
import type {
  YtDlpDownloadInvocation,
  YtDlpInvocation,
  YtDlpResult,
  YtDlpRunner,
} from './ytdlp-runner.port.js';
import { YtDlpProcessError } from './ytdlp-runner.port.js';

const execFileAsync = promisify(execFile);

/**
 * Lines yt-dlp emits because `ytdlp-nodejs` installs its own
 * `--progress-template`. They share stdout with the JSON document, so they are
 * stripped before parsing.
 */
const PROGRESS_LINE_PREFIX = '~ytdlp-progress-';

export interface YtDlpNodeRunnerOptions {
  readonly binaryPath: string;
  readonly ffmpegPath: string;
  readonly logger: Logger;
}

/**
 * The one place `ytdlp-nodejs` is used.
 *
 * Its builders earn their keep for downloads: they spawn with `shell: false`,
 * parse the progress stream into structured events, and expose `kill()` on the
 * live child, which is what makes the size watchdog and user cancellation work
 * at all. Arguments are still built by us and passed through `addArgs`, because
 * the library's abstract option API cannot express a `/` fallback chain and
 * quietly drops flags it does not model.
 */
export class YtDlpNodeRunner implements YtDlpRunner {
  #ytdlp: YtDlp | undefined;
  readonly #options: YtDlpNodeRunnerOptions;

  constructor(options: YtDlpNodeRunnerOptions) {
    this.#options = options;
  }

  /**
   * Built on first use, not in the constructor.
   *
   * `ytdlp-nodejs` stats both binaries when its builder is constructed and
   * writes straight to `console.error` if either is missing, bypassing our
   * logger and firing during composition-root wiring, where a missing binary is
   * neither actionable nor necessarily a problem yet. Deferring it means the
   * complaint arrives at the point of use, next to the request it affects.
   */
  get #client(): YtDlp {
    this.#ytdlp ??= new YtDlp({
      binaryPath: this.#options.binaryPath,
      ffmpegPath: this.#options.ffmpegPath,
    });
    return this.#ytdlp;
  }

  async dumpJson(invocation: YtDlpInvocation): Promise<YtDlpResult> {
    const builder = this.#client.exec(invocation.url, {});
    builder.setBinaryPath(this.#options.binaryPath);
    builder.setFfmpegPath(this.#options.ffmpegPath);
    builder.addArgs(...invocation.args);

    const detach = attachAbort(builder, invocation.signal);
    let stderr = '';
    builder.on('stderr', (chunk: string) => {
      stderr += chunk;
    });

    try {
      const result = await builder.exec();
      return {
        stdout: stripProgressLines(result.stdout),
        stderr: result.stderr,
        exitCode: result.exitCode,
        filePaths: result.filePaths ?? [],
      };
    } catch (error: unknown) {
      throw this.#toProcessError(error, stderr, invocation.signal);
    } finally {
      detach();
    }
  }

  async download(invocation: YtDlpDownloadInvocation): Promise<YtDlpResult> {
    const builder = this.#client.download(invocation.url, {});
    builder.setBinaryPath(this.#options.binaryPath);
    builder.setFfmpegPath(this.#options.ffmpegPath);
    if (invocation.formatSelector !== undefined) builder.format(invocation.formatSelector);
    builder.addArgs(...invocation.args);

    const detach = attachAbort(builder, invocation.signal);
    let stderr = '';
    builder.on('stderr', (chunk: string) => {
      stderr += chunk;
    });

    const onProgress = invocation.onProgress;
    if (onProgress !== undefined) {
      builder.on('progress', (progress: VideoProgress) => {
        onProgress(toDownloadProgress(progress));
      });
    }

    this.#options.logger.debug('starting yt-dlp download', {
      url: redactUrl(invocation.url),
      format: invocation.formatSelector,
    });

    try {
      const result = await builder.run();
      return {
        stdout: stripProgressLines(result.output),
        stderr: result.stderr,
        exitCode: 0,
        filePaths: result.filePaths,
      };
    } catch (error: unknown) {
      throw this.#toProcessError(error, stderr, invocation.signal);
    } finally {
      detach();
    }
  }

  async version(): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(this.#options.binaryPath, ['--version'], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      return stdout.trim();
    } catch (error: unknown) {
      this.#options.logger.warn('could not determine yt-dlp version', {
        error: describeError(error),
      });
      return undefined;
    }
  }

  /**
   * When we aborted the process ourselves, the abort reason is the truth about
   * why; yt-dlp's own output is whatever it managed to print before dying.
   */
  #toProcessError(error: unknown, stderr: string, signal: AbortSignal | undefined): Error {
    if (signal?.aborted === true) {
      const reason = toAbortError(signal.reason);
      return new YtDlpProcessError(null, 'SIGKILL', stderr, { cause: reason });
    }
    const message = error instanceof Error ? error.message : String(error);
    return new YtDlpProcessError(1, null, stderr === '' ? message : stderr, { cause: error });
  }
}

interface KillableBuilder {
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Bridge an `AbortSignal` onto the child process.
 *
 * SIGKILL rather than SIGTERM: this path is only reached when a hard limit was
 * breached or a user cancelled, and yt-dlp's own SIGTERM handling can spend
 * several seconds tidying up fragments while the disk keeps filling.
 */
function attachAbort(builder: KillableBuilder, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    builder.kill('SIGKILL');
    return () => undefined;
  }
  const onAbort = (): void => {
    builder.kill('SIGKILL');
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    signal.removeEventListener('abort', onAbort);
  };
}

function toDownloadProgress(progress: VideoProgress): DownloadProgress {
  return {
    downloadedBytes: progress.downloaded ?? 0,
    totalBytes: progress.total,
    percent: progress.percentage,
    speedBytesPerSecond: progress.speed,
    etaSeconds: progress.eta,
  };
}

function stripProgressLines(output: string): string {
  if (!output.includes(PROGRESS_LINE_PREFIX)) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(PROGRESS_LINE_PREFIX))
    .join('\n');
}
