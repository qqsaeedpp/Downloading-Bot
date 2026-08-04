import { ConfigurationError, MediaPlatform, megabytesToBytes } from '@tgtools/shared';
import type { z } from 'zod';
import type { AppConfig, CookieConfig } from './app-config.js';
import { envSchema } from './env.schema.js';
import type { RawEnv } from './env.schema.js';

/** Telegram's public Bot API refuses anything larger, whatever we configure. */
export const PUBLIC_API_UPLOAD_LIMIT_MB = 50;

/**
 * The ceiling assumed once a local Bot API server is in play.
 *
 * 1900 rather than the documented 2000 on purpose: the server measures its limit
 * on the ENCODED MULTIPART BODY, which is larger than the file inside it. A
 * ceiling of exactly 2000 gets the request refused after the whole file has been
 * streamed — the most expensive possible moment to discover it.
 */
export const LOCAL_API_UPLOAD_LIMIT_MB = 1_900;

/**
 * One setting, two spellings.
 *
 * The `TELEGRAM_LOCAL_MODE` / `TELEGRAM_UPLOAD_LIMIT_MB` pair is the documented
 * name; `TELEGRAM_USE_LOCAL_API` / `MAX_UPLOAD_MB` came first and is still
 * honoured, so upgrading does not mean editing a running deployment's `.env`.
 *
 * Conflicting values are refused rather than resolved by precedence. Silently
 * preferring one would mean an operator who set the old name and expected it to
 * apply gets the new one instead — and finds out when an upload fails, not at
 * startup.
 */
function resolveAlias<T>(
  modern: { readonly name: string; readonly value: T | undefined },
  legacy: { readonly name: string; readonly value: T | undefined },
  fallback: T,
  problems: string[],
): T {
  if (modern.value !== undefined && legacy.value !== undefined && modern.value !== legacy.value) {
    problems.push(
      `${modern.name}=${String(modern.value)} and ${legacy.name}=${String(legacy.value)} are two ` +
        `spellings of the same setting and disagree. Set them to the same value, or remove one.`,
    );
  }
  return modern.value ?? legacy.value ?? fallback;
}

/** The two aliased settings, resolved together — the ceiling's default needs the flag. */
export function resolveTelegramLimits(env: RawEnv): {
  readonly localMode: boolean;
  readonly uploadLimitMb: number;
  readonly problems: readonly string[];
} {
  const problems: string[] = [];

  const localMode = resolveAlias(
    { name: 'TELEGRAM_LOCAL_MODE', value: env.TELEGRAM_LOCAL_MODE },
    { name: 'TELEGRAM_USE_LOCAL_API', value: env.TELEGRAM_USE_LOCAL_API },
    false,
    problems,
  );

  const uploadLimitMb = resolveAlias(
    { name: 'TELEGRAM_UPLOAD_LIMIT_MB', value: env.TELEGRAM_UPLOAD_LIMIT_MB },
    { name: 'MAX_UPLOAD_MB', value: env.MAX_UPLOAD_MB },
    localMode ? LOCAL_API_UPLOAD_LIMIT_MB : PUBLIC_API_UPLOAD_LIMIT_MB,
    problems,
  );

  return { localMode, uploadLimitMb, problems };
}

/**
 * Validate the environment and shape it into {@link AppConfig}.
 *
 * Throws on the first problem. Failing at startup is the point: a bot that
 * boots with `MAX_UPLOAD_MB=2000` against the public API would look healthy and
 * then fail every single upload.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) throw new ConfigurationError(formatIssues(parsed.error));

  const env = parsed.data;
  assertCoherent(env);
  const telegram = resolveTelegramLimits(env);

  return {
    environment: env.NODE_ENV,
    version: env.APP_VERSION,

    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },

    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      apiRoot: env.TELEGRAM_API_ROOT,
      useLocalApi: telegram.localMode,
    },

    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
    },

    redis: {
      url: env.REDIS_URL,
    },

    binaries: {
      ytDlp: env.YTDLP_PATH,
      ffmpeg: env.FFMPEG_PATH,
      ffprobe: env.FFPROBE_PATH,
      jsRuntime: env.DENO_PATH,
    },

    storage: {
      downloadDir: env.DOWNLOAD_DIR,
      minFreeDiskBytes: megabytesToBytes(env.MIN_FREE_DISK_MB),
      orphanWorkspaceMaxAgeMs: env.ORPHAN_WORKSPACE_MAX_AGE_HOURS * 60 * 60 * 1000,
    },

    limits: {
      maxDownloadBytes: megabytesToBytes(env.MAX_DOWNLOAD_MB),
      maxUploadBytes: megabytesToBytes(telegram.uploadLimitMb),
      maxTranscodeBytes: megabytesToBytes(env.MAX_TRANSCODE_MB),
      videoFastDelivery: env.VIDEO_FAST_DELIVERY,
      maxActiveJobsPerUser: env.MAX_ACTIVE_JOBS_PER_USER,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitMaxRequests: env.RATE_LIMIT_MAX_REQUESTS,
      inspectRateLimitMax: env.INSPECT_RATE_LIMIT_MAX,
    },

    timeouts: {
      inspectMs: env.MEDIA_INSPECT_TIMEOUT_MS,
      downloadMs: env.DOWNLOAD_TIMEOUT_MS,
      ffmpegMs: env.FFMPEG_TIMEOUT_MS,
      ffprobeMs: env.FFPROBE_TIMEOUT_MS,
      uploadMs: env.TELEGRAM_UPLOAD_TIMEOUT_MS,
      jobMs: env.JOB_TIMEOUT_MS,
    },

    queue: {
      downloadConcurrency: env.DOWNLOAD_WORKER_CONCURRENCY,
      attempts: env.DOWNLOAD_JOB_ATTEMPTS,
      backoffMs: env.DOWNLOAD_JOB_BACKOFF_MS,
      lockDurationMs: env.DOWNLOAD_JOB_LOCK_DURATION_MS,
      removeCompleteAfterSeconds: env.QUEUE_REMOVE_COMPLETE_AFTER_SECONDS,
      removeFailAfterSeconds: env.QUEUE_REMOVE_FAIL_AFTER_SECONDS,
      shutdownGraceMs: env.WORKER_SHUTDOWN_GRACE_MS,
    },

    progress: {
      intervalMs: env.PROGRESS_UPDATE_INTERVAL_MS,
      minPercentDelta: env.PROGRESS_UPDATE_MIN_PERCENT,
    },

    cache: {
      mediaInfoTtlSeconds: env.MEDIA_INFO_CACHE_TTL_SECONDS,
      selectionTtlSeconds: env.DOWNLOAD_SELECTION_TTL_SECONDS,
    },

    ffmpeg: {
      videoCodec: env.FFMPEG_VIDEO_CODEC,
      audioCodec: env.FFMPEG_AUDIO_CODEC,
      preset: env.FFMPEG_PRESET,
      crf: env.FFMPEG_CRF,
    },

    cookies: buildCookieConfig(env),

    extraction: {
      proxyUrl: env.YTDLP_PROXY,
      extractorArgs: buildExtractorArgs(env),
      potProviderUrl: env.YOUTUBE_POT_PROVIDER_URL,
    },

    health: {
      botPort: env.BOT_HEALTH_PORT,
      workerPort: env.WORKER_HEALTH_PORT,
    },

    privacy: {
      storeFullSourceUrl: env.STORE_FULL_SOURCE_URL,
    },

    maintenance: {
      intervalMs: env.MAINTENANCE_INTERVAL_MS,
    },
  };
}

function buildCookieConfig(env: RawEnv): CookieConfig {
  const entries: [MediaPlatform, string | undefined][] = [
    [MediaPlatform.Instagram, env.INSTAGRAM_COOKIES_PATH],
    [MediaPlatform.TikTok, env.TIKTOK_COOKIES_PATH],
    [MediaPlatform.X, env.X_COOKIES_PATH],
    [MediaPlatform.Pinterest, env.PINTEREST_COOKIES_PATH],
    [MediaPlatform.YouTube, env.YOUTUBE_COOKIES_PATH],
  ];
  const cookies: Partial<Record<MediaPlatform, string>> = {};
  for (const [platform, path] of entries) {
    if (path !== undefined) cookies[platform] = path;
  }
  return cookies;
}

function buildExtractorArgs(env: RawEnv): Partial<Record<MediaPlatform, string>> {
  const entries: [MediaPlatform, string | undefined][] = [
    [MediaPlatform.Instagram, env.INSTAGRAM_EXTRACTOR_ARGS],
    [MediaPlatform.TikTok, env.TIKTOK_EXTRACTOR_ARGS],
    [MediaPlatform.X, env.X_EXTRACTOR_ARGS],
    [MediaPlatform.Pinterest, env.PINTEREST_EXTRACTOR_ARGS],
    [MediaPlatform.YouTube, env.YOUTUBE_EXTRACTOR_ARGS],
  ];
  const args: Partial<Record<MediaPlatform, string>> = {};
  for (const [platform, value] of entries) {
    if (value !== undefined) args[platform] = value;
  }
  return args;
}

/**
 * Relationships between variables that a per-field schema cannot see. Each of
 * these has a failure mode that is invisible until a real job runs.
 */
function assertCoherent(env: RawEnv): void {
  const telegram = resolveTelegramLimits(env);
  const problems: string[] = [...telegram.problems];

  if (!telegram.localMode && telegram.uploadLimitMb > PUBLIC_API_UPLOAD_LIMIT_MB) {
    problems.push(
      `The upload ceiling is ${telegram.uploadLimitMb} MB, over the ` +
        `${PUBLIC_API_UPLOAD_LIMIT_MB} MB limit of Telegram's public Bot API. Lower it, or run a ` +
        `local Bot API server and set TELEGRAM_LOCAL_MODE=true together with TELEGRAM_API_ROOT.`,
    );
  }

  if (telegram.localMode && env.TELEGRAM_API_ROOT === undefined) {
    problems.push('TELEGRAM_LOCAL_MODE=true requires TELEGRAM_API_ROOT to be set.');
  }

  if (telegram.uploadLimitMb > env.MAX_DOWNLOAD_MB) {
    problems.push(
      `The upload ceiling is ${telegram.uploadLimitMb} MB but MAX_DOWNLOAD_MB=` +
        `${env.MAX_DOWNLOAD_MB}; nothing could ever grow large enough to use that headroom.`,
    );
  }

  if (env.MAX_TRANSCODE_MB > env.MAX_DOWNLOAD_MB) {
    problems.push(
      `MAX_TRANSCODE_MB=${env.MAX_TRANSCODE_MB} exceeds MAX_DOWNLOAD_MB=${env.MAX_DOWNLOAD_MB}.`,
    );
  }

  // BullMQ renews the lock halfway through its duration, but only while the
  // processor yields. A lock shorter than a single download step means the job
  // gets declared stalled and handed to a second worker mid-flight.
  if (env.DOWNLOAD_JOB_LOCK_DURATION_MS >= env.JOB_TIMEOUT_MS) {
    problems.push(
      `DOWNLOAD_JOB_LOCK_DURATION_MS must be shorter than JOB_TIMEOUT_MS, otherwise a job can ` +
        `never be reclaimed after a worker dies.`,
    );
  }

  const stepBudget =
    env.DOWNLOAD_TIMEOUT_MS + env.FFMPEG_TIMEOUT_MS + env.TELEGRAM_UPLOAD_TIMEOUT_MS;
  if (stepBudget > env.JOB_TIMEOUT_MS) {
    problems.push(
      `JOB_TIMEOUT_MS=${env.JOB_TIMEOUT_MS} is smaller than the sum of its step timeouts ` +
        `(${stepBudget}ms). The job would be killed before its slowest legal path completes.`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigurationError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

function formatIssues(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `  - ${path}: ${issue.message}`;
  });
  return `Invalid environment configuration:\n${lines.join('\n')}`;
}
