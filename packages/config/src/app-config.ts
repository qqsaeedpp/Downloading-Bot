import type { LogLevel, MediaPlatform } from '@tgtools/shared';

export type AppEnvironment = 'development' | 'test' | 'production';

export interface LoggingConfig {
  readonly level: LogLevel;
  readonly pretty: boolean;
}

export interface TelegramConfig {
  readonly botToken: string;
  readonly apiRoot: string | undefined;
  /**
   * True when `apiRoot` is our own Bot API server. Only then may we exceed the
   * public API's 50 MB upload ceiling.
   */
  readonly useLocalApi: boolean;
  /**
   * Absolute directories a local Bot API server's `getFile` result may name.
   *
   * Empty unless {@link useLocalApi}. A local server hands us a path on ITS
   * filesystem and we open whatever it names, so this list is the boundary that
   * makes that safe: a path landing outside every entry is refused rather than
   * read.
   */
  readonly localFileRoots: readonly string[];
}

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
}

export interface RedisConfig {
  readonly url: string;
}

export interface BinariesConfig {
  readonly ytDlp: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /**
   * External JavaScript runtime. Required by yt-dlp for YouTube since
   * 2025.11.12; without it the format list comes back empty or reduced.
   */
  readonly jsRuntime: string;
}

export interface StorageConfig {
  readonly downloadDir: string;
  readonly minFreeDiskBytes: number;
  readonly orphanWorkspaceMaxAgeMs: number;
}

export interface LimitsConfig {
  /** Ceiling on what may be pulled from the network. */
  readonly maxDownloadBytes: number;
  /** Ceiling on what Telegram will accept from us. Always <= maxDownloadBytes. */
  readonly maxUploadBytes: number;
  /** Above this, an incompatible codec is remuxed rather than re-encoded. */
  readonly maxTranscodeBytes: number;
  /**
   * Ship a file Telegram can already play rather than re-encoding it first.
   *
   * The trade is arrival time against in-app playback: a 4K AV1 clip takes
   * longer to transcode than most people will wait, so it is delivered as a
   * document with its original codec instead. Turn off to always normalise to
   * H.264/AAC, however long that takes.
   */
  readonly videoFastDelivery: boolean;
  readonly maxActiveJobsPerUser: number;
  readonly rateLimitWindowMs: number;
  readonly rateLimitMaxRequests: number;
  readonly inspectRateLimitMax: number;
}

export interface TimeoutsConfig {
  readonly inspectMs: number;
  readonly downloadMs: number;
  readonly ffmpegMs: number;
  readonly ffprobeMs: number;
  readonly uploadMs: number;
  readonly jobMs: number;
}

export interface QueueConfig {
  readonly downloadConcurrency: number;
  readonly attempts: number;
  readonly backoffMs: number;
  readonly lockDurationMs: number;
  readonly removeCompleteAfterSeconds: number;
  readonly removeFailAfterSeconds: number;
  readonly shutdownGraceMs: number;
}

export interface ProgressConfig {
  readonly intervalMs: number;
  readonly minPercentDelta: number;
}

export interface CacheConfig {
  readonly mediaInfoTtlSeconds: number;
  readonly selectionTtlSeconds: number;
}

export interface FfmpegConfig {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly preset: string;
  readonly crf: number;
}

/**
 * The file tools: eight image/video/PDF/QR operations run by a separate worker.
 *
 * Grouped rather than flattened into `limits` because these ceilings answer a
 * different question. The downloader's limits are about what Telegram will
 * accept; these are about what one shared host can be asked to do for one user
 * without starving everyone else.
 */
export interface ToolsConfig {
  /**
   * The master switch. Off by default: a deployment that only wants the
   * downloader should not be running image and video processing, and should not
   * be able to be broken by it.
   */
  readonly enabled: boolean;
  /** Per-family switches, so one misbehaving family can be shed without the rest. */
  readonly imageEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly pdfEnabled: boolean;
  readonly qrEnabled: boolean;

  readonly sessionTtlSeconds: number;
  readonly workspaceDir: string;
  readonly minFreeDiskBytes: number;
  readonly jobTimeoutMs: number;
  readonly uploadTimeoutMs: number;

  readonly image: {
    readonly maxInputBytes: number;
    /** Decompression-bomb guard: a small file can declare an enormous canvas. */
    readonly maxPixels: number;
    readonly maxDimension: number;
    readonly concurrency: number;
  };
  readonly video: {
    readonly maxInputBytes: number;
    readonly maxDurationSeconds: number;
    readonly concurrency: number;
    readonly timeoutMs: number;
  };
  readonly pdf: {
    readonly maxInputBytes: number;
    readonly maxPages: number;
    readonly maxImages: number;
    readonly renderDpi: number;
    readonly concurrency: number;
    readonly timeoutMs: number;
  };
  readonly qr: {
    readonly maxInputBytes: number;
    readonly concurrency: number;
    readonly timeoutMs: number;
  };

  readonly queue: {
    readonly attempts: number;
    readonly backoffMs: number;
    readonly lockDurationMs: number;
  };

  readonly orphanWorkspaceMaxAgeHours: number;
  readonly maintenanceIntervalMs: number;
  readonly maxActiveJobsPerUser: number;
  readonly progressUpdateIntervalMs: number;
  readonly healthPort: number;
}

export interface HealthConfig {
  readonly botPort: number;
  readonly workerPort: number;
}

export interface PrivacyConfig {
  readonly storeFullSourceUrl: boolean;
}

export interface MaintenanceConfig {
  readonly intervalMs: number;
}

/** Paths to Netscape `cookies.txt` files, keyed by platform. */
export type CookieConfig = Readonly<Partial<Record<MediaPlatform, string>>>;

export interface ExtractionConfig {
  /**
   * Routes every yt-dlp request through a proxy. The usual reason is that
   * YouTube treats datacentre address space as suspicious, and a residential
   * exit resolves that without any account being involved.
   */
  readonly proxyUrl: string | undefined;
  /**
   * Per-platform `--extractor-args` values, WITHOUT the extractor prefix — the
   * policy supplies that. Exists so the workaround for a platform's newest
   * anti-automation measure is a configuration change, not a release.
   */
  readonly extractorArgs: Readonly<Partial<Record<MediaPlatform, string>>>;
  /**
   * Base URL of a self-hosted proof-of-origin token provider.
   *
   * The account-free counterpart to {@link proxyUrl}: it attests that a request
   * came from a real browser environment, which is what YouTube's bot check is
   * actually asking for. Costs nothing to run and puts no account at risk, but
   * the upstream project is explicit that a PO token "may help" rather than
   * guarantee a bypass — on a comprehensively flagged address it can still fail.
   */
  readonly potProviderUrl: string | undefined;
}

/**
 * The whole of this process's configuration, resolved once at startup and then
 * passed explicitly. Deliberately not a module-level singleton: a test that
 * needs a different ceiling should be able to build a second config rather than
 * mutate a global.
 */
export interface AppConfig {
  readonly environment: AppEnvironment;
  readonly version: string;
  readonly logging: LoggingConfig;
  readonly telegram: TelegramConfig;
  readonly database: DatabaseConfig;
  readonly redis: RedisConfig;
  readonly binaries: BinariesConfig;
  readonly storage: StorageConfig;
  readonly limits: LimitsConfig;
  readonly timeouts: TimeoutsConfig;
  readonly queue: QueueConfig;
  readonly progress: ProgressConfig;
  readonly cache: CacheConfig;
  readonly ffmpeg: FfmpegConfig;
  readonly cookies: CookieConfig;
  readonly extraction: ExtractionConfig;
  readonly tools: ToolsConfig;
  readonly health: HealthConfig;
  readonly privacy: PrivacyConfig;
  readonly maintenance: MaintenanceConfig;
}
