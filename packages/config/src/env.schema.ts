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

/**
 * Bounded, but with no default — `undefined` means "the operator said nothing".
 *
 * Needed wherever the default cannot be written next to the field because it
 * depends on another one. The upload ceiling is 50 MB against the public Bot API
 * and 1900 against a local server; a `.default()` here would make those
 * indistinguishable from a deliberate 50.
 */
const optionalInt = ({ min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.coerce.number().int().min(min).max(max).optional();

/** As {@link booleanFlag}, but distinguishes "unset" from "explicitly false". */
const optionalBooleanFlag = () =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return undefined;
      const value = raw.trim().toLowerCase();
      if (TRUTHY.has(value)) return true;
      if (FALSY.has(value)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, received "${raw}"` });
      return z.NEVER;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().trim().min(1).default('0.0.0'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: booleanFlag(false),

  TELEGRAM_BOT_TOKEN: requiredText('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_API_ROOT: optionalText(),
  // Two spellings of one setting. TELEGRAM_LOCAL_MODE is the documented name;
  // TELEGRAM_USE_LOCAL_API predates it and is still honoured so that upgrading
  // does not require editing a running deployment's .env. Both left unset means
  // false. Both set to DIFFERENT values is rejected rather than silently
  // resolved — see `assertCoherent`.
  TELEGRAM_LOCAL_MODE: optionalBooleanFlag(),
  TELEGRAM_USE_LOCAL_API: optionalBooleanFlag(),

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
  // Same pairing as the local-mode flag above: TELEGRAM_UPLOAD_LIMIT_MB is the
  // documented name, MAX_UPLOAD_MB the older one. Neither carries a default,
  // because the right default depends on the local-mode flag — 1900 against a
  // local server, 50 against the public API.
  //
  // The cap is 1900 and not 2000 deliberately. Telegram's local-server limit is
  // 2000 MB measured on the encoded multipart body, which is larger than the
  // file; a ceiling set at exactly 2000 produces a rejection at the very end of
  // a long upload, which is the most expensive possible moment to fail.
  TELEGRAM_UPLOAD_LIMIT_MB: optionalInt({ max: 1_900 }),
  MAX_UPLOAD_MB: optionalInt({ max: 1_900 }),
  // 80 MB, not 250. This is the size above which an incompatible codec ships as
  // a document instead of being re-encoded, and the ceiling has to be set by
  // how long a person will wait rather than by what the machine can survive: a
  // 250 MB VP9 clip is minutes of CPU, during which the user sees a progress
  // message and no file. Raise it only on a host with cores to spare.
  MAX_TRANSCODE_MB: positiveInt(80, { max: 20_000 }),
  MIN_FREE_DISK_MB: positiveInt(2_048, { min: 0 }),

  // Deliver playable files as they are rather than spending minutes re-encoding
  // them. Default on: a 4K AV1 file transcodes for longer than most users will
  // wait, and arriving as a document immediately is the better trade.
  VIDEO_FAST_DELIVERY: booleanFlag(true),

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

  // ── File tools ─────────────────────────────────────────────────────────
  // The eight image/video/PDF/QR operations, all behind one master switch so a
  // deployment that only wants the downloader pays nothing for them and cannot
  // be broken by them.
  TOOLS_ENABLED: booleanFlag(false),
  IMAGE_TOOLS_ENABLED: booleanFlag(true),
  VIDEO_TOOLS_ENABLED: booleanFlag(true),
  PDF_TOOLS_ENABLED: booleanFlag(true),
  QR_TOOLS_ENABLED: booleanFlag(true),

  // How long a half-finished conversation survives. Long enough to find and
  // send a file, short enough that an abandoned draft does not hold a user's
  // one active slot until they notice.
  TOOL_SESSION_TTL_SECONDS: positiveInt(900, { min: 60, max: 86_400 }),

  TOOL_WORKSPACE_DIR: z.string().trim().min(1).default('/data/tools'),
  TOOL_MIN_FREE_DISK_MB: positiveInt(2_048, { min: 0 }),
  TOOL_JOB_TIMEOUT_MS: positiveInt(3_600_000, { min: 10_000 }),
  TOOL_UPLOAD_TIMEOUT_MS: positiveInt(900_000, { min: 10_000 }),

  // Per-family ceilings. Split rather than shared because the resources differ
  // by orders of magnitude: a 12000x12000 image and a two-hour video fail for
  // completely different reasons and at completely different sizes.
  // 20, not 50: the public Bot API refuses `getFile` above 20 MB, so a larger
  // default would promise to accept files the bot could never collect. Raise
  // these three once a local Bot API server is in play — see the coherence
  // rule, which checks them against what THIS deployment can actually fetch.
  IMAGE_TOOL_MAX_MB: positiveInt(20, { min: 1, max: 2_000 }),
  // Guards against a decompression bomb: a few-kilobyte PNG can declare a
  // canvas large enough to exhaust the host's memory when decoded.
  IMAGE_TOOL_MAX_PIXELS: positiveInt(60_000_000, { min: 1_000_000 }),
  IMAGE_TOOL_MAX_DIMENSION: positiveInt(12_000, { min: 16 }),
  IMAGE_TOOL_CONCURRENCY: positiveInt(3, { min: 1, max: 32 }),

  VIDEO_TOOL_MAX_MB: positiveInt(20, { min: 1, max: 4_000 }),
  VIDEO_TOOL_MAX_DURATION_SECONDS: positiveInt(7_200, { min: 1 }),
  // One by default and deliberately: FFmpeg already saturates the cores it is
  // given, so a second concurrent transcode makes both slower, not the pair
  // faster.
  VIDEO_TOOL_CONCURRENCY: positiveInt(1, { min: 1, max: 8 }),
  VIDEO_TOOL_TIMEOUT_MS: positiveInt(1_800_000, { min: 10_000 }),

  PDF_TOOL_MAX_MB: positiveInt(20, { min: 1, max: 2_000 }),
  PDF_TOOL_MAX_PAGES: positiveInt(50, { min: 1, max: 5_000 }),
  PDF_TOOL_MAX_IMAGES: positiveInt(50, { min: 1, max: 500 }),
  PDF_RENDER_DPI: positiveInt(150, { min: 36, max: 600 }),
  PDF_TOOL_CONCURRENCY: positiveInt(1, { min: 1, max: 8 }),
  PDF_TOOL_TIMEOUT_MS: positiveInt(900_000, { min: 10_000 }),

  // A QR is milliseconds of work, so it gets the highest concurrency and the
  // shortest timeout of the four.
  QR_MAX_INPUT_BYTES: positiveInt(1_500, { min: 16, max: 7_089 }),
  QR_TOOL_CONCURRENCY: positiveInt(4, { min: 1, max: 32 }),
  QR_TOOL_TIMEOUT_MS: positiveInt(30_000, { min: 1_000 }),

  TOOL_QUEUE_JOB_ATTEMPTS: positiveInt(2, { min: 1, max: 10 }),
  TOOL_QUEUE_BACKOFF_MS: positiveInt(5_000, { min: 100 }),
  TOOL_QUEUE_LOCK_DURATION_MS: positiveInt(60_000, { min: 10_000 }),

  TOOL_ORPHAN_WORKSPACE_MAX_AGE_HOURS: positiveInt(6, { min: 1, max: 168 }),
  TOOL_MAINTENANCE_INTERVAL_MS: positiveInt(900_000, { min: 60_000 }),
  MAX_ACTIVE_TOOL_JOBS_PER_USER: positiveInt(2, { min: 1, max: 20 }),
  TOOL_PROGRESS_UPDATE_INTERVAL_MS: positiveInt(3_000, { min: 500 }),

  TOOLS_WORKER_HEALTH_PORT: positiveInt(3_003, { min: 1, max: 65_535 }),

  BOT_HEALTH_PORT: positiveInt(3_001, { min: 1, max: 65_535 }),
  WORKER_HEALTH_PORT: positiveInt(3_002, { min: 1, max: 65_535 }),

  STORE_FULL_SOURCE_URL: booleanFlag(false),
});

export type RawEnv = z.infer<typeof envSchema>;
