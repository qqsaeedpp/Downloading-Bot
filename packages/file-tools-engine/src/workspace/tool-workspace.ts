import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { ToolError, ToolErrorCode } from '../errors/tool-error.js';

/**
 * One disposable directory per job.
 *
 * Every filename that reaches this layer began in a Telegram message, so no
 * user-supplied string is ever used to build a path. Names are generated; the
 * user's own filename survives only as metadata for the caption and as a hint
 * for choosing an extension.
 *
 * The three subdirectories are not decoration. `input` is what arrived,
 * `output` is what will be sent, and `temp` is everything in between — which
 * means "delete the intermediates but keep the result" is a directory removal
 * rather than a pattern match on filenames.
 */

export interface ToolWorkspace {
  readonly jobId: string;
  readonly root: string;
  readonly inputDir: string;
  readonly outputDir: string;
  readonly tempDir: string;
  /**
   * A path inside this workspace with a generated name.
   *
   * @param area which subdirectory
   * @param extension without the dot; validated, because it is often derived
   *   from a user-supplied filename
   */
  path(area: 'input' | 'output' | 'temp', extension: string): string;
  /** Throws unless `candidate` is genuinely inside this workspace. */
  assertInside(candidate: string): void;
  /** Removes everything. Safe to call twice, and never throws. */
  dispose(): Promise<void>;
}

/** Letters and digits only: an extension is not a place for path syntax. */
const SAFE_EXTENSION = /^[A-Za-z0-9]{1,12}$/;

export interface WorkspaceManagerOptions {
  /** Absolute. Every workspace lives under it and nothing may escape it. */
  readonly rootDir: string;
  /** Refuse to start a job when the volume has less than this free. */
  readonly minFreeDiskBytes?: number;
}

export class ToolWorkspaceManager {
  readonly #root: string;

  constructor(private readonly options: WorkspaceManagerOptions) {
    if (!isAbsolute(options.rootDir)) {
      throw new ToolError(
        ToolErrorCode.InternalError,
        `workspace root must be absolute, received "${options.rootDir}"`,
      );
    }
    this.#root = resolve(options.rootDir);
  }

  get rootDir(): string {
    return this.#root;
  }

  /** Called once at startup: a workspace root that cannot be written is fatal. */
  async ensureRoot(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async create(jobId: string): Promise<ToolWorkspace> {
    // The job id is ours (a UUID), but it arrives here as a string from a queue
    // payload, so it is checked rather than trusted.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
      throw new ToolError(ToolErrorCode.InternalError, 'job id is not a safe directory name');
    }

    const root = join(this.#root, jobId);
    const inputDir = join(root, 'input');
    const outputDir = join(root, 'output');
    const tempDir = join(root, 'temp');

    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await mkdir(tempDir, { recursive: true });

    const assertInside = (candidate: string): void => {
      const resolved = resolve(candidate);
      // Compare with a trailing separator so `/data/tools/ab` cannot pass as
      // being inside `/data/tools/a`.
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new ToolError(ToolErrorCode.InternalError, 'path escapes the job workspace', {
          context: { jobId },
        });
      }
    };

    return {
      jobId,
      root,
      inputDir,
      outputDir,
      tempDir,
      path: (area, extension) => {
        if (!SAFE_EXTENSION.test(extension)) {
          throw new ToolError(ToolErrorCode.InternalError, `unsafe file extension "${extension}"`, {
            context: { jobId },
          });
        }
        const directory = area === 'input' ? inputDir : area === 'output' ? outputDir : tempDir;
        const candidate = join(directory, `${randomUUID()}.${extension}`);
        assertInside(candidate);
        return candidate;
      },
      assertInside,
      dispose: async () => {
        await rm(root, { recursive: true, force: true }).catch(() => {
          // A cleanup failure must never replace the job's real outcome. The
          // periodic sweep will collect it.
        });
      },
    };
  }

  /**
   * Run `work` with a workspace and remove it afterwards, whatever happened.
   *
   * The only way a workspace should be created. A caller holding a raw
   * workspace has to remember to dispose it on the error path too, and the path
   * that gets forgotten is always the error path.
   */
  async with<T>(jobId: string, work: (workspace: ToolWorkspace) => Promise<T>): Promise<T> {
    const workspace = await this.create(jobId);
    try {
      return await work(workspace);
    } finally {
      await workspace.dispose();
    }
  }

  /**
   * Delete workspaces older than `maxAgeMs`.
   *
   * Bounded to the root by construction, and it only ever removes DIRECTORIES
   * whose name looks like a job id. A sweep that deleted whatever it found
   * would be one misconfigured path away from removing something else.
   */
  async sweepOrphans(maxAgeMs: number, now = Date.now()): Promise<readonly string[]> {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return removed;
    }

    for (const entry of entries) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry)) continue;
      const candidate = join(this.#root, entry);
      try {
        // `lstat`, not `stat`: a symlink here must be recognised as a symlink
        // and skipped, not followed to whatever it points at.
        const info = await lstat(candidate);
        if (!info.isDirectory()) continue;
        if (now - info.mtimeMs < maxAgeMs) continue;
        await rm(candidate, { recursive: true, force: true });
        removed.push(entry);
      } catch {
        // Raced with a job disposing its own workspace. Expected.
      }
    }
    return removed;
  }

  /** Free space on the workspace volume, or `undefined` where unsupported. */
  async freeDiskBytes(): Promise<number | undefined> {
    try {
      const info = await stat(this.#root);
      void info;
      const { statfs } = await import('node:fs/promises');
      const fsStat = await statfs(this.#root);
      return fsStat.bavail * fsStat.bsize;
    } catch {
      return undefined;
    }
  }

  /**
   * Refuse a job when the volume is nearly full.
   *
   * Checked before the work rather than during: a tool that runs out of disk
   * half way through leaves a partial file and a confusing error, where this
   * produces one clear message and no wasted CPU.
   */
  async assertDiskSpace(): Promise<void> {
    const required = this.options.minFreeDiskBytes;
    if (required === undefined || required <= 0) return;
    const free = await this.freeDiskBytes();
    if (free === undefined) return;
    if (free < required) {
      throw new ToolError(ToolErrorCode.DiskSpaceLow, 'not enough free disk for a tool job', {
        context: { freeBytes: free, requiredBytes: required },
      });
    }
  }
}

/**
 * Reject a path that is, or passes through, a symlink.
 *
 * Used on anything read from a mount we do not own — the Telegram Bot API
 * volume in particular. A symlink there could point at `/etc` or at the token
 * directory, and following it would read a file the bot has no business
 * reading.
 */
export async function assertNotSymlinked(path: string, allowedRoot: string): Promise<void> {
  const root = resolve(allowedRoot);
  let real: string;
  try {
    real = await realpath(path);
  } catch (error: unknown) {
    throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'file is not readable', {
      cause: error,
    });
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new ToolError(ToolErrorCode.InternalError, 'file resolves outside the permitted root');
  }
}
