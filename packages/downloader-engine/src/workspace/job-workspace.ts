import { mkdir, mkdtemp, readdir, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '@tgtools/shared';
import { assertContainedPath, describeError, formatBytes } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';

export interface JobWorkspace {
  readonly jobId: string;
  readonly directory: string;
  /** The `-o` value handed to yt-dlp. Never contains the media title. */
  createOutputTemplate(): string;
  listFiles(): Promise<readonly string[]>;
  getSize(): Promise<number>;
  cleanup(): Promise<void>;
}

export interface WorkspaceFactoryOptions {
  readonly rootDirectory: string;
  readonly logger: Logger;
  readonly minFreeBytes: number;
}

export interface WorkspaceFactory {
  create(jobId: string): Promise<JobWorkspace>;
  /** Sweep directories left behind by a crashed worker. */
  removeOrphans(maxAgeMs: number): Promise<number>;
  ensureWritable(): Promise<void>;
}

const WORKSPACE_PREFIX = 'job-';

export function createWorkspaceFactory(options: WorkspaceFactoryOptions): WorkspaceFactory {
  const { rootDirectory, logger, minFreeBytes } = options;

  return {
    async create(jobId: string): Promise<JobWorkspace> {
      await mkdir(rootDirectory, { recursive: true });
      await assertSpaceAvailable(rootDirectory, minFreeBytes);
      // `mkdtemp` gets uniqueness from the kernel, so two workers starting the
      // same instant cannot collide. That matters more than it sounds: yt-dlp
      // SKIPS an output whose file already exists and then reports the stale
      // path, so a shared directory turns "give me 1080p" into "here is the
      // 720p someone else downloaded an hour ago".
      const directory = await mkdtemp(join(rootDirectory, WORKSPACE_PREFIX));
      logger.debug('workspace created', { jobId, directory });
      return new FsJobWorkspace(jobId, directory, logger);
    },

    async removeOrphans(maxAgeMs: number): Promise<number> {
      let removed = 0;
      let entries: string[];
      try {
        entries = await readdir(rootDirectory);
      } catch {
        return 0; // Root not created yet — nothing can be orphaned.
      }
      const cutoff = Date.now() - maxAgeMs;
      for (const entry of entries) {
        if (!entry.startsWith(WORKSPACE_PREFIX)) continue;
        const directory = join(rootDirectory, entry);
        try {
          const stats = await stat(directory);
          if (!stats.isDirectory() || stats.mtimeMs > cutoff) continue;
          await rm(directory, { recursive: true, force: true });
          removed += 1;
          logger.info('removed orphaned workspace', {
            directory,
            ageMs: Date.now() - stats.mtimeMs,
          });
        } catch (error: unknown) {
          logger.warn('could not remove orphaned workspace', {
            directory,
            error: describeError(error),
          });
        }
      }
      return removed;
    },

    async ensureWritable(): Promise<void> {
      await mkdir(rootDirectory, { recursive: true });
      const probe = await mkdtemp(join(rootDirectory, '.probe-'));
      await rm(probe, { recursive: true, force: true });
    },
  };
}

class FsJobWorkspace implements JobWorkspace {
  #cleaned = false;

  constructor(
    readonly jobId: string,
    readonly directory: string,
    private readonly logger: Logger,
  ) {}

  /**
   * `%(id)s` rather than `%(title)s`.
   *
   * A title is remote input: it can be 400 characters of RTL override marks, or
   * `../../etc/passwd`. The extractor id is short and constrained, and the
   * user-facing filename is derived separately from the sanitised title once the
   * file is safely on disk.
   */
  createOutputTemplate(): string {
    return join(this.directory, '%(id).100s.%(ext)s');
  }

  async listFiles(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(this.directory, entry.name));
    } catch {
      return [];
    }
  }

  async getSize(): Promise<number> {
    let total = 0;
    for (const file of await this.listFiles()) {
      try {
        total += (await stat(file)).size;
      } catch {
        // Mid-rename or already gone: yt-dlp swaps `.part` files constantly, and
        // a missing one contributes nothing to the total anyway.
      }
    }
    return total;
  }

  async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    this.#cleaned = true;
    try {
      // Resolve symlinks before deleting: a post-processor could in principle
      // leave a link pointing out of the workspace, and `rm -r` would follow the
      // directory it names.
      const safeDirectory = await assertContainedPath(this.directory, this.directory);
      await rm(safeDirectory, { recursive: true, force: true });
      this.logger.debug('workspace removed', { jobId: this.jobId, directory: this.directory });
    } catch (error: unknown) {
      // Cleanup failure must never mask the job's own outcome; the orphan sweep
      // will get it on the next pass.
      this.logger.warn('workspace cleanup failed', {
        jobId: this.jobId,
        directory: this.directory,
        error: describeError(error),
      });
    }
  }
}

/**
 * Refuse to start rather than fill the disk.
 *
 * Losing the volume takes the container runtime with it, so a job that cannot
 * possibly fit is better declined up front — the user gets a clear message
 * instead of a stack that fell over.
 */
async function assertSpaceAvailable(directory: string, minFreeBytes: number): Promise<void> {
  if (minFreeBytes <= 0) return;
  let free: number;
  try {
    const stats = await statfs(directory);
    free = stats.bavail * stats.bsize;
  } catch {
    // `statfs` is unavailable on some filesystems. The runtime size watchdog
    // still bounds the damage, so this is a warning condition, not a failure.
    return;
  }
  if (free < minFreeBytes) {
    throw new EngineError(
      EngineFailureCode.InsufficientStorage,
      `Only ${formatBytes(free)} free on the download volume; ${formatBytes(minFreeBytes)} required`,
      { context: { freeBytes: free, minFreeBytes } },
    );
  }
}
