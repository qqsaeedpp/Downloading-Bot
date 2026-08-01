import { ConfigurationError, MediaPlatform } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { PUBLIC_API_UPLOAD_LIMIT_MB, loadConfig } from './load-config.js';

const BOT_TOKEN = '7000000000:AAF-token-for-tests';
const DATABASE_URL = 'postgres://tgtools:secret@localhost:5432/tgtools';
const REDIS_URL = 'redis://localhost:6379';

/** The three genuinely required variables. Everything else has a default. */
const REQUIRED_ENV: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  DATABASE_URL,
  REDIS_URL,
};

function env(overrides: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { ...REQUIRED_ENV, ...overrides };
}

function envWithout(key: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env()).filter(([name]) => name !== key));
}

describe('loadConfig', () => {
  it('turns a minimal environment into the fully defaulted nested config', () => {
    const config = loadConfig(env());

    expect(config).toEqual({
      environment: 'development',
      version: '0.0.0',
      logging: { level: 'info', pretty: false },
      telegram: { botToken: BOT_TOKEN, apiRoot: undefined, useLocalApi: false },
      database: { url: DATABASE_URL, poolMax: 10 },
      redis: { url: REDIS_URL },
      binaries: { ytDlp: 'yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      storage: {
        downloadDir: '/data/downloads',
        minFreeDiskBytes: 2_147_483_648,
        orphanWorkspaceMaxAgeMs: 21_600_000,
      },
      limits: {
        maxDownloadBytes: 524_288_000,
        maxUploadBytes: 52_428_800,
        maxTranscodeBytes: 262_144_000,
        maxActiveJobsPerUser: 2,
        rateLimitWindowMs: 60_000,
        rateLimitMaxRequests: 20,
        inspectRateLimitMax: 10,
      },
      timeouts: {
        inspectMs: 30_000,
        downloadMs: 900_000,
        ffmpegMs: 900_000,
        ffprobeMs: 30_000,
        uploadMs: 900_000,
        jobMs: 3_600_000,
      },
      queue: {
        downloadConcurrency: 2,
        attempts: 2,
        backoffMs: 5_000,
        lockDurationMs: 60_000,
        removeCompleteAfterSeconds: 3_600,
        removeFailAfterSeconds: 604_800,
        shutdownGraceMs: 30_000,
      },
      progress: { intervalMs: 3_000, minPercentDelta: 5 },
      cache: { mediaInfoTtlSeconds: 600, selectionTtlSeconds: 1_800 },
      ffmpeg: { videoCodec: 'libx264', audioCodec: 'aac', preset: 'veryfast', crf: 23 },
      cookies: {},
      extraction: { proxyUrl: undefined, extractorArgs: {} },
      health: { botPort: 3_001, workerPort: 3_002 },
      privacy: { storeFullSourceUrl: false },
      maintenance: { intervalMs: 900_000 },
    });
    expect(config.telegram.apiRoot).toBeUndefined();
  });

  it('converts every megabyte limit into bytes using binary megabytes', () => {
    const config = loadConfig(
      env({
        MAX_DOWNLOAD_MB: '1000',
        MAX_UPLOAD_MB: '50',
        MAX_TRANSCODE_MB: '4',
        MIN_FREE_DISK_MB: '1',
      }),
    );

    expect(config.limits.maxDownloadBytes).toBe(1000 * 1024 * 1024);
    expect(config.limits.maxUploadBytes).toBe(50 * 1024 * 1024);
    expect(config.limits.maxTranscodeBytes).toBe(4 * 1024 * 1024);
    expect(config.storage.minFreeDiskBytes).toBe(1024 * 1024);
  });

  it('converts the orphan workspace age from hours to milliseconds', () => {
    expect(
      loadConfig(env({ ORPHAN_WORKSPACE_MAX_AGE_HOURS: '3' })).storage.orphanWorkspaceMaxAgeMs,
    ).toBe(10_800_000);
  });

  it('coerces numeric strings to numbers rather than leaving them as text', () => {
    const config = loadConfig(env({ DATABASE_POOL_MAX: '25', BOT_HEALTH_PORT: '4001' }));

    expect(config.database.poolMax).toBe(25);
    expect(config.health.botPort).toBe(4001);
  });

  it('exposes the account-free extraction escape hatches', () => {
    // A cookie file is one answer to a platform's bot check; a proxy or a
    // different player client are the ones that need no account at all. Both
    // must be reachable from the environment, because the workaround changes
    // faster than any release cycle.
    const config = loadConfig(
      env({
        YTDLP_PROXY: 'socks5://10.0.0.9:1080',
        YOUTUBE_EXTRACTOR_ARGS: 'player_client=android_vr',
      }),
    );

    expect(config.extraction.proxyUrl).toBe('socks5://10.0.0.9:1080');
    expect(config.extraction.extractorArgs.youtube).toBe('player_client=android_vr');
    // Unset platforms stay absent rather than becoming an empty string, which
    // would put a meaningless `--extractor-args tiktok:` on the command line.
    expect(config.extraction.extractorArgs.tiktok).toBeUndefined();
  });

  it('boots on the shipped defaults alone', () => {
    // Regression guard. DOWNLOAD + FFMPEG + UPLOAD default to 900_000 ms each,
    // so the JOB_TIMEOUT_MS default has to exceed their 2_700_000 ms sum. It
    // briefly did not, which made a minimal environment a hard startup failure.
    const config = loadConfig(env());
    const stepBudget =
      config.timeouts.downloadMs + config.timeouts.ffmpegMs + config.timeouts.uploadMs;
    expect(config.timeouts.jobMs).toBeGreaterThanOrEqual(stepBudget);
  });

  it('still rejects a job timeout shorter than the steps it has to cover', () => {
    expect(() => loadConfig(env({ JOB_TIMEOUT_MS: '60000' }))).toThrow(/step timeouts/);
  });

  describe('required variables', () => {
    it('throws when TELEGRAM_BOT_TOKEN is missing', () => {
      expect(() => loadConfig(envWithout('TELEGRAM_BOT_TOKEN'))).toThrow(ConfigurationError);
      expect(() => loadConfig(envWithout('TELEGRAM_BOT_TOKEN'))).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it('throws when TELEGRAM_BOT_TOKEN is present but blank', () => {
      expect(() => loadConfig(env({ TELEGRAM_BOT_TOKEN: '   ' }))).toThrow(/TELEGRAM_BOT_TOKEN/);
    });

    it('throws when DATABASE_URL or REDIS_URL is missing', () => {
      expect(() => loadConfig(envWithout('DATABASE_URL'))).toThrow(/DATABASE_URL/);
      expect(() => loadConfig(envWithout('REDIS_URL'))).toThrow(/REDIS_URL/);
    });
  });

  describe('upload ceiling coherence', () => {
    it('refuses MAX_UPLOAD_MB=2000 on the public Bot API', () => {
      expect(() => loadConfig(env({ MAX_UPLOAD_MB: '2000', MAX_DOWNLOAD_MB: '4000' }))).toThrow(
        ConfigurationError,
      );
      expect(() => loadConfig(env({ MAX_UPLOAD_MB: '2000', MAX_DOWNLOAD_MB: '4000' }))).toThrow(
        new RegExp(`${PUBLIC_API_UPLOAD_LIMIT_MB} MB limit of Telegram's public Bot API`),
      );
    });

    it('accepts exactly the public API limit without a local server', () => {
      expect(
        loadConfig(env({ MAX_UPLOAD_MB: String(PUBLIC_API_UPLOAD_LIMIT_MB) })).limits
          .maxUploadBytes,
      ).toBe(PUBLIC_API_UPLOAD_LIMIT_MB * 1024 * 1024);
    });

    it('accepts a 2000 MB upload once a local Bot API server is configured', () => {
      const config = loadConfig(
        env({
          MAX_UPLOAD_MB: '2000',
          MAX_DOWNLOAD_MB: '4000',
          TELEGRAM_USE_LOCAL_API: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
        }),
      );

      expect(config.telegram.useLocalApi).toBe(true);
      expect(config.telegram.apiRoot).toBe('http://telegram-bot-api:8081');
      expect(config.limits.maxUploadBytes).toBe(2000 * 1024 * 1024);
    });

    it('throws when the local API is enabled without TELEGRAM_API_ROOT', () => {
      expect(() => loadConfig(env({ TELEGRAM_USE_LOCAL_API: 'true' }))).toThrow(
        /TELEGRAM_USE_LOCAL_API=true requires TELEGRAM_API_ROOT/,
      );
    });

    it('treats an empty TELEGRAM_API_ROOT as unset', () => {
      expect(() =>
        loadConfig(env({ TELEGRAM_USE_LOCAL_API: 'true', TELEGRAM_API_ROOT: '   ' })),
      ).toThrow(/TELEGRAM_API_ROOT/);
    });

    it('throws when MAX_UPLOAD_MB exceeds MAX_DOWNLOAD_MB', () => {
      expect(() => loadConfig(env({ MAX_UPLOAD_MB: '50', MAX_DOWNLOAD_MB: '20' }))).toThrow(
        /exceeds MAX_DOWNLOAD_MB=20/,
      );
    });

    it('throws when MAX_TRANSCODE_MB exceeds MAX_DOWNLOAD_MB', () => {
      expect(() =>
        loadConfig(env({ MAX_DOWNLOAD_MB: '100', MAX_UPLOAD_MB: '50', MAX_TRANSCODE_MB: '200' })),
      ).toThrow(/MAX_TRANSCODE_MB=200 exceeds MAX_DOWNLOAD_MB=100/);
    });
  });

  describe('timeout coherence', () => {
    it('throws when the step timeouts add up to more than JOB_TIMEOUT_MS', () => {
      expect(() =>
        loadConfig(
          env({
            DOWNLOAD_TIMEOUT_MS: '60000',
            FFMPEG_TIMEOUT_MS: '60000',
            TELEGRAM_UPLOAD_TIMEOUT_MS: '60000',
            JOB_TIMEOUT_MS: '100000',
          }),
        ),
      ).toThrow(/smaller than the sum of its step timeouts \(180000ms\)/);
    });

    it('accepts step timeouts that exactly fill the job budget', () => {
      const config = loadConfig(
        env({
          DOWNLOAD_TIMEOUT_MS: '60000',
          FFMPEG_TIMEOUT_MS: '60000',
          TELEGRAM_UPLOAD_TIMEOUT_MS: '60000',
          JOB_TIMEOUT_MS: '180000',
        }),
      );

      expect(config.timeouts.jobMs).toBe(180_000);
    });

    it('throws when the BullMQ lock lasts at least as long as the job budget', () => {
      expect(() =>
        loadConfig(
          env({
            DOWNLOAD_JOB_LOCK_DURATION_MS: '2700000',
            JOB_TIMEOUT_MS: '2700000',
          }),
        ),
      ).toThrow(/DOWNLOAD_JOB_LOCK_DURATION_MS must be shorter than JOB_TIMEOUT_MS/);
    });

    it('reports every coherence problem at once rather than only the first', () => {
      let message = '';
      try {
        loadConfig(env({ MAX_UPLOAD_MB: '2000', MAX_DOWNLOAD_MB: '100' }));
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('public Bot API');
      expect(message).toContain('exceeds MAX_DOWNLOAD_MB=100');
    });
  });

  describe('boolean parsing', () => {
    it('accepts true, 1, yes and on as true, in any casing', () => {
      for (const raw of ['true', '1', 'yes', 'on', 'TRUE', ' Yes ']) {
        expect(loadConfig(env({ LOG_PRETTY: raw })).logging.pretty).toBe(true);
      }
    });

    it('accepts false, 0, no, off and the empty string as false', () => {
      for (const raw of ['false', '0', 'no', 'off', '']) {
        expect(loadConfig(env({ LOG_PRETTY: raw })).logging.pretty).toBe(false);
      }
    });

    it('falls back to the default when the flag is absent', () => {
      expect(loadConfig(env()).privacy.storeFullSourceUrl).toBe(false);
      expect(loadConfig(env({ STORE_FULL_SOURCE_URL: 'yes' })).privacy.storeFullSourceUrl).toBe(
        true,
      );
    });

    it('rejects a value that is neither truthy nor falsy', () => {
      expect(() => loadConfig(env({ LOG_PRETTY: 'maybe' }))).toThrow(ConfigurationError);
      expect(() => loadConfig(env({ LOG_PRETTY: 'maybe' }))).toThrow(
        /expected a boolean, received "maybe"/,
      );
    });
  });

  describe('cookie paths', () => {
    it('keys each configured cookie file by its platform', () => {
      const config = loadConfig(
        env({
          INSTAGRAM_COOKIES_PATH: '/secrets/instagram.txt',
          TIKTOK_COOKIES_PATH: '/secrets/tiktok.txt',
          X_COOKIES_PATH: '/secrets/x.txt',
          PINTEREST_COOKIES_PATH: '/secrets/pinterest.txt',
        }),
      );

      expect(config.cookies).toEqual({
        [MediaPlatform.Instagram]: '/secrets/instagram.txt',
        [MediaPlatform.TikTok]: '/secrets/tiktok.txt',
        [MediaPlatform.X]: '/secrets/x.txt',
        [MediaPlatform.Pinterest]: '/secrets/pinterest.txt',
      });
    });

    it('omits a platform whose cookie path is an empty or whitespace string', () => {
      const config = loadConfig(
        env({
          INSTAGRAM_COOKIES_PATH: '/secrets/instagram.txt',
          TIKTOK_COOKIES_PATH: '',
          X_COOKIES_PATH: '   ',
        }),
      );

      expect(config.cookies).toEqual({ [MediaPlatform.Instagram]: '/secrets/instagram.txt' });
      expect(Object.keys(config.cookies)).not.toContain(MediaPlatform.TikTok);
      expect(Object.keys(config.cookies)).not.toContain(MediaPlatform.X);
    });

    it('trims surrounding whitespace from a configured path', () => {
      expect(
        loadConfig(env({ INSTAGRAM_COOKIES_PATH: '  /secrets/instagram.txt  ' })).cookies[
          MediaPlatform.Instagram
        ],
      ).toBe('/secrets/instagram.txt');
    });

    it('is empty when no cookie files are configured', () => {
      expect(loadConfig(env()).cookies).toEqual({});
    });
  });

  describe('enumerated values', () => {
    it('accepts the documented NODE_ENV and LOG_LEVEL values', () => {
      const config = loadConfig(env({ NODE_ENV: 'production', LOG_LEVEL: 'warn' }));

      expect(config.environment).toBe('production');
      expect(config.logging.level).toBe('warn');
    });

    it('rejects an unknown LOG_LEVEL', () => {
      expect(() => loadConfig(env({ LOG_LEVEL: 'verbose' }))).toThrow(ConfigurationError);
    });

    it('rejects an unknown FFMPEG_PRESET', () => {
      expect(() => loadConfig(env({ FFMPEG_PRESET: 'turbo' }))).toThrow(/FFMPEG_PRESET/);
    });

    it('rejects an out-of-range FFMPEG_CRF', () => {
      expect(() => loadConfig(env({ FFMPEG_CRF: '99' }))).toThrow(ConfigurationError);
    });
  });
});
