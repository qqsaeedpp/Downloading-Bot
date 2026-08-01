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
  readonly health: HealthConfig;
  readonly privacy: PrivacyConfig;
  readonly maintenance: MaintenanceConfig;
}
