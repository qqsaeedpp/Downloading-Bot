import { z } from 'zod';

/**
 * Environment variables arrive as strings or not at all. Everything is coerced
 * and bounded here so that the rest of the codebase can treat configuration as
 * ordinary, already-valid data.
 */

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined) return defaultValue;
      const value = raw.trim().toLowerCase();
      if (TRUTHY.has(value)) return true;
      if (FALSY.has(value)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, received "${raw}"` });
      return z.NEVER;
    });

/** An unset variable and an empty one mean the same thing: "not configured". */
const optionalText = () =>
  z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? '';
      return trimmed === '' ? undefined : trimmed;
    });

const requiredText = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} must not be empty`);

const positiveInt = (defaultValue: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().trim().min(1).default('0.0.0'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFlag(false),

  TELEGRAM_BOT_TOKEN: requiredText('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_API_ROOT: optionalText(),
  TELEGRAM_USE_LOCAL_API: booleanFlag(false),

  DATABASE_URL: requiredText('DATABASE_URL'),
  DATABASE_POOL_MAX: positiveInt(10, { max: 200 }),
  REDIS_URL: requiredText('REDIS_URL'),

  YTDLP_PATH: z.string().trim().min(1).default('yt-dlp'),
  FFMPEG_PATH: z.string().trim().min(1).default('ffmpeg'),
  FFPROBE_PATH: z.string().trim().min(1).default('ffprobe'),
  // The JavaScript runtime yt-dlp uses for YouTube's player challenge. yt-dlp
  // finds it on PATH itself; this is used to report its version at startup.
  DENO_PATH: z.string().trim().min(1).default('deno'),

  DOWNLOAD_DIR: z.string().trim().min(1).default('/data/downloads'),

  MAX_DOWNLOAD_MB: positiveInt(500, { max: 20_000 }),
  MAX_UPLOAD_MB: positiveInt(50, { max: 2_000 }),
  MAX_TRANSCODE_MB: positiveInt(250, { max: 20_000 }),
  MIN_FREE_DISK_MB: positiveInt(2_048, { min: 0 }),

  MEDIA_INSPECT_TIMEOUT_MS: positiveInt(30_000, { min: 1_000 }),
  DOWNLOAD_TIMEOUT_MS: positiveInt(900_000, { min: 1_000 }),
  FFMPEG_TIMEOUT_MS: positiveInt(900_000, { min: 1_000 }),
  FFPROBE_TIMEOUT_MS: positiveInt(30_000, { min: 1_000 }),
  TELEGRAM_UPLOAD_TIMEOUT_MS: positiveInt(900_000, { min: 1_000 }),
  // Must cover the worst legal path — download + normalise + upload — with room
  // to spare, or `assertCoherent` refuses to start. The three step budgets above
  // sum to 45 minutes; this is an hour.
  JOB_TIMEOUT_MS: positiveInt(3_600_000, { min: 1_000 }),

  DOWNLOAD_WORKER_CONCURRENCY: positiveInt(2, { max: 64 }),
  DOWNLOAD_JOB_ATTEMPTS: positiveInt(2, { max: 10 }),
  DOWNLOAD_JOB_BACKOFF_MS: positiveInt(5_000, { min: 100 }),
  DOWNLOAD_JOB_LOCK_DURATION_MS: positiveInt(60_000, { min: 10_000 }),
  QUEUE_REMOVE_COMPLETE_AFTER_SECONDS: positiveInt(3_600, { min: 60 }),
  QUEUE_REMOVE_FAIL_AFTER_SECONDS: positiveInt(604_800, { min: 60 }),
  WORKER_SHUTDOWN_GRACE_MS: positiveInt(30_000, { min: 1_000 }),

  PROGRESS_UPDATE_INTERVAL_MS: positiveInt(3_000, { min: 500 }),
  PROGRESS_UPDATE_MIN_PERCENT: positiveInt(5, { min: 1, max: 100 }),

  MEDIA_INFO_CACHE_TTL_SECONDS: positiveInt(600, { min: 0 }),
  DOWNLOAD_SELECTION_TTL_SECONDS: positiveInt(1_800, { min: 60 }),
  ORPHAN_WORKSPACE_MAX_AGE_HOURS: positiveInt(6, { min: 1 }),
  MAINTENANCE_INTERVAL_MS: positiveInt(900_000, { min: 60_000 }),

  MAX_ACTIVE_JOBS_PER_USER: positiveInt(2, { max: 50 }),
  RATE_LIMIT_WINDOW_MS: positiveInt(60_000, { min: 1_000 }),
  RATE_LIMIT_MAX_REQUESTS: positiveInt(20, { min: 1 }),
  INSPECT_RATE_LIMIT_MAX: positiveInt(10, { min: 1 }),

  FFMPEG_VIDEO_CODEC: z.string().trim().min(1).default('libx264'),
  FFMPEG_AUDIO_CODEC: z.string().trim().min(1).default('aac'),
  FFMPEG_PRESET: z
    .enum([
      'ultrafast',
      'superfast',
      'veryfast',
      'faster',
      'fast',
      'medium',
      'slow',
      'slower',
      'veryslow',
    ])
    .default('veryfast'),
  FFMPEG_CRF: positiveInt(23, { min: 0, max: 51 }),

  INSTAGRAM_COOKIES_PATH: optionalText(),
  TIKTOK_COOKIES_PATH: optionalText(),
  X_COOKIES_PATH: optionalText(),
  PINTEREST_COOKIES_PATH: optionalText(),
  YOUTUBE_COOKIES_PATH: optionalText(),

  // ── Extraction tuning ──────────────────────────────────────────────────
  // Escape hatches, so the answer to an extractor change is an environment
  // variable and a restart rather than a release.
  YTDLP_PROXY: optionalText(),
  // Base URL of a self-hosted proof-of-origin token provider, e.g.
  // `http://bgutil-provider:4416`. Account-free and costs nothing to run; the
  // provider's own README is clear that a PO token "may help" rather than
  // guarantee a bypass, so this is a lever to try, not a promise.
  YOUTUBE_POT_PROVIDER_URL: optionalText(),
  INSTAGRAM_EXTRACTOR_ARGS: optionalText(),
  TIKTOK_EXTRACTOR_ARGS: optionalText(),
  X_EXTRACTOR_ARGS: optionalText(),
  PINTEREST_EXTRACTOR_ARGS: optionalText(),
  YOUTUBE_EXTRACTOR_ARGS: optionalText(),

  BOT_HEALTH_PORT: positiveInt(3_001, { min: 1, max: 65_535 }),
  WORKER_HEALTH_PORT: positiveInt(3_002, { min: 1, max: 65_535 }),

  STORE_FULL_SOURCE_URL: booleanFlag(false),
});

export type RawEnv = z.infer<typeof envSchema>;
