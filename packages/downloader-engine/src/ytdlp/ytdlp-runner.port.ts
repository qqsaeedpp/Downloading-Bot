import type { DownloadProgress } from '@tgtools/shared';

export interface YtDlpInvocation {
  readonly args: readonly string[];
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

export interface YtDlpDownloadInvocation extends YtDlpInvocation {
  /** The `-f` expression. Passed separately so the runner can log it. */
  readonly formatSelector: string | undefined;
  readonly onProgress: ((progress: DownloadProgress) => void) | undefined;
}

export interface YtDlpResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** Paths yt-dlp reported writing. Empty for skip-download runs. */
  readonly filePaths: readonly string[];
}

/**
 * The engine's seam over the yt-dlp process.
 *
 * Everything above this interface is pure orchestration — selector chains,
 * retries, mapping — and can be tested by handing it a scripted runner. The one
 * implementation that actually spawns a process is
 * {@link YtDlpNodeRunner}, and it is the only file in the package that imports
 * `ytdlp-nodejs`.
 */
export interface YtDlpRunner {
  /** Metadata extraction: no progress, one JSON document on stdout. */
  dumpJson(invocation: YtDlpInvocation): Promise<YtDlpResult>;
  /** A real download, with live progress and a killable process. */
  download(invocation: YtDlpDownloadInvocation): Promise<YtDlpResult>;
  version(): Promise<string | undefined>;
}

/**
 * Raised when the process ends badly. Carries the pieces the error mapper needs
 * without pre-judging what they mean.
 */
export class YtDlpProcessError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderr: string,
    options: { cause?: unknown } = {},
  ) {
    super(`yt-dlp exited with code ${String(exitCode)}`, options);
    this.name = 'YtDlpProcessError';
  }
}
