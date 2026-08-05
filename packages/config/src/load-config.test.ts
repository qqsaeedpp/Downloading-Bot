import { ConfigurationError, MediaPlatform } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_API_UPLOAD_LIMIT_MB,
  PUBLIC_API_UPLOAD_LIMIT_MB,
  loadConfig,
} from './load-config.js';

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
      binaries: { ytDlp: 'yt-dlp', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', jsRuntime: 'deno' },
      storage: {
        downloadDir: '/data/downloads',
        minFreeDiskBytes: 2_147_483_648,
        orphanWorkspaceMaxAgeMs: 21_600_000,
      },
      limits: {
        maxDownloadBytes: 524_288_000,
        maxUploadBytes: 52_428_800,
        maxTranscodeBytes: 83_886_080,
        videoFastDelivery: true,
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
      extraction: { proxyUrl: undefined, extractorArgs: {}, potProviderUrl: undefined },
      // Off by default: a downloader-only deployment runs no image or video
      // processing and cannot be broken by it.
      tools: {
        enabled: false,
        imageEnabled: true,
        videoEnabled: true,
        pdfEnabled: true,
        qrEnabled: true,
        sessionTtlSeconds: 900,
        workspaceDir: '/data/tools',
        minFreeDiskBytes: 2_147_483_648,
        jobTimeoutMs: 3_600_000,
        uploadTimeoutMs: 900_000,
        image: {
          maxInputBytes: 20_971_520,
          maxPixels: 60_000_000,
          maxDimension: 12_000,
          concurrency: 3,
        },
        video: {
          maxInputBytes: 20_971_520,
          maxDurationSeconds: 7_200,
          concurrency: 1,
          timeoutMs: 1_800_000,
        },
        pdf: {
          maxInputBytes: 20_971_520,
          maxPages: 50,
          maxImages: 50,
          renderDpi: 150,
          concurrency: 1,
          timeoutMs: 900_000,
        },
        qr: { maxInputBytes: 1_500, concurrency: 4, timeoutMs: 30_000 },
        queue: { attempts: 2, backoffMs: 5_000, lockDurationMs: 60_000 },
        orphanWorkspaceMaxAgeHours: 6,
        maintenanceIntervalMs: 900_000,
        maxActiveJobsPerUser: 2,
        progressUpdateIntervalMs: 3_000,
        healthPort: 3_003,
      },
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
    it('refuses an upload ceiling above what even a local server accepts', () => {
      // 1900 rather than 2000 is deliberate: the local server measures its 2000 MB
      // limit on the encoded multipart body, which is larger than the file inside
      // it. Anything above that is refused before the process starts, because the
      // alternative is discovering it after streaming a two-gigabyte upload.
      expect(() => loadConfig(env({ MAX_UPLOAD_MB: '2000', MAX_DOWNLOAD_MB: '4000' }))).toThrow(
        ConfigurationError,
      );
      expect(() => loadConfig(env({ MAX_UPLOAD_MB: '2000', MAX_DOWNLOAD_MB: '4000' }))).toThrow(
        /1900/,
      );
    });

    it('refuses the local-server ceiling while still on the public Bot API', () => {
      // The pairing is what matters: 1900 MB is legal, but only behind a local
      // server. Without one every upload over 50 MB would fail at Telegram.
      expect(() =>
        loadConfig(env({ TELEGRAM_UPLOAD_LIMIT_MB: '1900', MAX_DOWNLOAD_MB: '4000' })),
      ).toThrow(new RegExp(`${PUBLIC_API_UPLOAD_LIMIT_MB} MB limit of Telegram's public Bot API`));
    });

    it('accepts exactly the public API limit without a local server', () => {
      expect(
        loadConfig(env({ MAX_UPLOAD_MB: String(PUBLIC_API_UPLOAD_LIMIT_MB) })).limits
          .maxUploadBytes,
      ).toBe(PUBLIC_API_UPLOAD_LIMIT_MB * 1024 * 1024);
    });

    it('accepts a 1900 MB upload once a local Bot API server is configured', () => {
      const config = loadConfig(
        env({
          MAX_UPLOAD_MB: '1900',
          MAX_DOWNLOAD_MB: '4000',
          TELEGRAM_USE_LOCAL_API: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
        }),
      );

      expect(config.telegram.useLocalApi).toBe(true);
      expect(config.telegram.apiRoot).toBe('http://telegram-bot-api:8081');
      expect(config.limits.maxUploadBytes).toBe(1900 * 1024 * 1024);
    });

    it('defaults to the local-server ceiling when local mode is on', () => {
      // The reason the ceiling carries no schema default: the right number
      // depends on a different variable. An operator who stands up a local server
      // should not also have to remember a magic number to unlock it.
      const config = loadConfig(
        env({
          TELEGRAM_LOCAL_MODE: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
          MAX_DOWNLOAD_MB: '4000',
        }),
      );

      expect(config.limits.maxUploadBytes).toBe(LOCAL_API_UPLOAD_LIMIT_MB * 1024 * 1024);
    });

    it('keeps the 50 MB default when nothing about local mode is said', () => {
      // The other half of the same decision. A silent environment must stay on
      // the public API's terms — guessing generously here would make every large
      // upload fail at Telegram instead of at startup.
      expect(loadConfig(env()).limits.maxUploadBytes).toBe(
        PUBLIC_API_UPLOAD_LIMIT_MB * 1024 * 1024,
      );
    });

    it('still honours the older TELEGRAM_USE_LOCAL_API spelling on its own', () => {
      // Deployments predating the rename are running unattended. Dropping the old
      // name would quietly drop their upload ceiling from 1900 MB to 50 on an
      // upgrade nobody thought was risky.
      const config = loadConfig(
        env({
          TELEGRAM_USE_LOCAL_API: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
          MAX_DOWNLOAD_MB: '4000',
        }),
      );

      expect(config.telegram.useLocalApi).toBe(true);
      expect(config.limits.maxUploadBytes).toBe(LOCAL_API_UPLOAD_LIMIT_MB * 1024 * 1024);
    });

    it('refuses two spellings of local mode that disagree', () => {
      // Picking a winner by precedence would mean an operator who set the name
      // they knew gets the behaviour of the one they did not, and finds out when
      // an upload fails. The message has to name both, because the operator is
      // looking at only one of them in their .env.
      let message = '';
      try {
        loadConfig(
          env({
            TELEGRAM_LOCAL_MODE: 'true',
            TELEGRAM_USE_LOCAL_API: 'false',
            TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
            MAX_DOWNLOAD_MB: '4000',
          }),
        );
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('TELEGRAM_LOCAL_MODE');
      expect(message).toContain('TELEGRAM_USE_LOCAL_API');
    });

    it('refuses two spellings of the upload ceiling that disagree', () => {
      let message = '';
      try {
        loadConfig(
          env({
            TELEGRAM_UPLOAD_LIMIT_MB: '1900',
            MAX_UPLOAD_MB: '50',
            TELEGRAM_LOCAL_MODE: 'true',
            TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
            MAX_DOWNLOAD_MB: '4000',
          }),
        );
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('TELEGRAM_UPLOAD_LIMIT_MB');
      expect(message).toContain('MAX_UPLOAD_MB');
    });

    it('accepts both spellings when they agree', () => {
      // The realistic upgrade path: the new name gets added next to the old one
      // and both say the same thing. That is not a conflict and must not read as
      // one.
      const config = loadConfig(
        env({
          TELEGRAM_LOCAL_MODE: 'true',
          TELEGRAM_USE_LOCAL_API: 'true',
          TELEGRAM_UPLOAD_LIMIT_MB: '1000',
          MAX_UPLOAD_MB: '1000',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
          MAX_DOWNLOAD_MB: '4000',
        }),
      );

      expect(config.telegram.useLocalApi).toBe(true);
      expect(config.limits.maxUploadBytes).toBe(1000 * 1024 * 1024);
    });

    it('throws when the local API is enabled without TELEGRAM_API_ROOT', () => {
      // Local mode with nowhere to send the request is the one combination that
      // looks healthy at startup and fails on every single job.
      expect(() =>
        loadConfig(env({ TELEGRAM_LOCAL_MODE: 'true', MAX_DOWNLOAD_MB: '4000' })),
      ).toThrow(/TELEGRAM_LOCAL_MODE=true requires TELEGRAM_API_ROOT/);
      expect(() =>
        loadConfig(env({ TELEGRAM_USE_LOCAL_API: 'true', MAX_DOWNLOAD_MB: '4000' })),
      ).toThrow(/requires TELEGRAM_API_ROOT/);
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

    it('throws when the local-mode ceiling exceeds MAX_DOWNLOAD_MB', () => {
      // Nothing can ever grow into that headroom, so the pair describes an
      // intention the process cannot carry out. Most likely someone raised the
      // upload ceiling and forgot that the file has to be downloaded first.
      expect(() =>
        loadConfig(
          env({
            TELEGRAM_LOCAL_MODE: 'true',
            TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
            TELEGRAM_UPLOAD_LIMIT_MB: '1900',
            MAX_DOWNLOAD_MB: '500',
          }),
        ),
      ).toThrow(/upload ceiling is 1900 MB but MAX_DOWNLOAD_MB=500/);
    });

    it('throws when MAX_TRANSCODE_MB exceeds MAX_DOWNLOAD_MB', () => {
      expect(() =>
        loadConfig(env({ MAX_DOWNLOAD_MB: '100', MAX_UPLOAD_MB: '50', MAX_TRANSCODE_MB: '200' })),
      ).toThrow(/MAX_TRANSCODE_MB=200 exceeds MAX_DOWNLOAD_MB=100/);
    });
  });

  describe('video delivery', () => {
    it('defaults to shipping a playable file rather than re-encoding it', () => {
      // The default decides how the bot feels to use: a 4K AV1 clip transcodes
      // for longer than most people will wait, and arriving now as a document
      // beats arriving in ten minutes as a video.
      expect(loadConfig(env()).limits.videoFastDelivery).toBe(true);
    });

    it('can be turned off for deployments that want in-app playback at any cost', () => {
      expect(loadConfig(env({ VIDEO_FAST_DELIVERY: 'false' })).limits.videoFastDelivery).toBe(
        false,
      );
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
        // MAX_TRANSCODE_MB is set explicitly rather than left to its default.
        // It used to default to 250, which happened to exceed the 100 below and
        // so raised the second problem by accident — so lowering the default
        // silently turned this into a one-problem test.
        loadConfig(env({ MAX_UPLOAD_MB: '1900', MAX_DOWNLOAD_MB: '100', MAX_TRANSCODE_MB: '250' }));
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

/**
 * The tool ceilings that only make sense in relation to each other.
 *
 * Every one of these has the same failure shape if unchecked: the job is
 * accepted, the work is paid for, and the rejection arrives at the end — which
 * is the most expensive possible moment to discover a misconfiguration.
 */
describe('file-tool coherence', () => {
  const on = { TOOLS_ENABLED: 'true' };

  it('says nothing about tool settings while the tools are off', () => {
    // A downloader-only deployment must not be refused startup over a ceiling
    // it will never reach.
    expect(() =>
      loadConfig(env({ TOOLS_ENABLED: 'false', VIDEO_TOOL_MAX_MB: '4000' })),
    ).not.toThrow();
  });

  it('boots on the shipped tool defaults once enabled', () => {
    // The same regression the downloader already had: defaults that individually
    // look fine and together refuse to start.
    expect(() => loadConfig(env(on))).not.toThrow();
  });

  it('refuses an input ceiling above what the bot could ever download', () => {
    // The public Bot API refuses `getFile` above 20 MB whatever the upload
    // ceiling says, so a larger input limit promises to accept files the bot
    // cannot collect.
    expect(() => loadConfig(env({ ...on, VIDEO_TOOL_MAX_MB: '400' }))).toThrow(
      /VIDEO_TOOL_MAX_MB=400 is above the 20 MB this deployment can download/,
    );
  });

  it('does NOT compare an input ceiling against the upload ceiling', () => {
    // A 500 MB video that yields a 5 MB MP3 is the entire point of the tool.
    // Conflating the two limits would forbid exactly the useful case.
    expect(() =>
      loadConfig(
        env({
          ...on,
          VIDEO_TOOL_MAX_MB: '500',
          TELEGRAM_LOCAL_MODE: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
          MAX_DOWNLOAD_MB: '2000',
        }),
      ),
    ).not.toThrow();
  });

  it('leaves the dimension and pixel ceilings independent', () => {
    // They guard different things: an absurd single side versus total decoded
    // area. A 12000x2000 panorama is 24 megapixels and entirely reasonable,
    // while 12000 squared is 144 — so requiring the square to fit would forbid
    // ordinary configurations.
    expect(() =>
      loadConfig(
        env({ ...on, IMAGE_TOOL_MAX_DIMENSION: '12000', IMAGE_TOOL_MAX_PIXELS: '60000000' }),
      ),
    ).not.toThrow();
  });

  it('allows a larger family ceiling once a local Bot API server raises the roof', () => {
    // The ceiling is relative, not absolute: 400 MB is illegal on the public
    // API and unremarkable against a local server.
    expect(() =>
      loadConfig(
        env({
          ...on,
          VIDEO_TOOL_MAX_MB: '400',
          TELEGRAM_LOCAL_MODE: 'true',
          TELEGRAM_API_ROOT: 'http://telegram-bot-api:8081',
          MAX_DOWNLOAD_MB: '2000',
        }),
      ),
    ).not.toThrow();
  });

  it('refuses a step timeout longer than the whole job budget', () => {
    expect(() =>
      loadConfig(env({ ...on, PDF_TOOL_TIMEOUT_MS: '7200000', TOOL_JOB_TIMEOUT_MS: '600000' })),
    ).toThrow(/PDF_TOOL_TIMEOUT_MS=7200000 exceeds TOOL_JOB_TIMEOUT_MS/);
  });

  it('refuses a queue lock that outlives the work it protects', () => {
    // BullMQ renews the lock at lockDuration/2 while the processor is alive, so
    // it is meant to be far shorter than a step. One that outlives the work
    // stops a genuinely stalled job from ever being reclaimed.
    expect(() => loadConfig(env({ ...on, TOOL_QUEUE_LOCK_DURATION_MS: '1800000' }))).toThrow(
      /not shorter than the longest tool step/,
    );
  });

  it('refuses a render DPI whose own output would be rejected as an image', () => {
    // "PDF to images" at 600 DPI produces pages larger than the image ceiling,
    // so every rendered page fails — after the render is already paid for.
    expect(() =>
      loadConfig(env({ ...on, PDF_RENDER_DPI: '600', IMAGE_TOOL_MAX_PIXELS: '1000000' })),
    ).toThrow(/PDF_RENDER_DPI=600 renders an A4 page/);
  });

  it('refuses to let the tools and the downloader share a workspace', () => {
    // Both sweep their directory for orphans on a timer, so sharing one means
    // each can delete the other's in-flight files.
    expect(() =>
      loadConfig(env({ ...on, TOOL_WORKSPACE_DIR: '/data/x', DOWNLOAD_DIR: '/data/x' })),
    ).toThrow(/independent cleanup sweeps/);
  });

  it('reports every tool problem at once rather than only the first', () => {
    let message = '';
    try {
      loadConfig(env({ ...on, VIDEO_TOOL_MAX_MB: '400', PDF_TOOL_MAX_MB: '300' }));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('VIDEO_TOOL_MAX_MB=400');
    expect(message).toContain('PDF_TOOL_MAX_MB=300');
  });
});
