import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import type { EngineBundle } from '@tgtools/downloader-engine';
import { CryptoIdGenerator, MediaPlatform, createNoopLogger } from '@tgtools/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The only suite that touches the public internet.
 *
 * Extractors break when a site changes its markup, which no fixture can
 * predict — so this exists to answer "does yt-dlp still understand these four
 * platforms" after a version bump. It is NOT part of `npm test`: it needs a
 * real binary, real network access and real URLs, and any of those being
 * unavailable would turn an ordinary CI run red for reasons unrelated to the
 * change under review.
 *
 *   RUN_SMOKE_TESTS=1 SMOKE_INSTAGRAM_URL=... npm run test:smoke
 */
const ENABLED = process.env.RUN_SMOKE_TESTS === '1';
const MB = 1024 * 1024;

const TARGETS = [
  { platform: MediaPlatform.Instagram, url: process.env.SMOKE_INSTAGRAM_URL },
  { platform: MediaPlatform.TikTok, url: process.env.SMOKE_TIKTOK_URL },
  { platform: MediaPlatform.Pinterest, url: process.env.SMOKE_PINTEREST_URL },
  { platform: MediaPlatform.X, url: process.env.SMOKE_X_URL },
  { platform: MediaPlatform.YouTube, url: process.env.SMOKE_YOUTUBE_URL },
] as const;

describe.skipIf(!ENABLED)('extractor smoke tests', () => {
  let downloadDir: string;
  let bundle: EngineBundle;

  beforeAll(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-smoke-'));
    bundle = createDownloaderEngine({
      binaries: {
        ytDlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
        ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
        ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
      },
      limits: {
        maxDownloadBytes: 100 * MB,
        maxTranscodeBytes: 50 * MB,
        minFreeDiskBytes: 0,
        inspectTimeoutMs: 60_000,
        downloadTimeoutMs: 120_000,
        ffmpegTimeoutMs: 120_000,
        ffprobeTimeoutMs: 30_000,
      },
      ffmpeg: { videoCodec: 'libx264', audioCodec: 'aac', preset: 'veryfast', crf: 23 },
      downloadDirectory: downloadDir,
      cookiePaths: {},
      idGenerator: new CryptoIdGenerator(),
      logger: createNoopLogger(),
    });
  });

  afterAll(async () => {
    if (downloadDir !== undefined) await rm(downloadDir, { recursive: true, force: true });
  });

  it('reports a usable yt-dlp version', async () => {
    const toolchain = await bundle.engine.probeToolchain();
    expect(toolchain.ytDlpVersion).toBeDefined();
    expect(toolchain.ffmpegVersion).toBeDefined();
  });

  for (const target of TARGETS) {
    // Each platform is skipped independently: an operator validating a yt-dlp
    // bump may only have a link handy for one of them.
    it.skipIf(target.url === undefined)(
      `still extracts metadata from ${target.platform}`,
      async () => {
        const safe = bundle.urlGuard.parse(target.url ?? '');
        const resolved = await bundle.redirectResolver.resolve(safe);

        const info = await bundle.engine.inspect({
          url: resolved.originalUrl,
          platform: resolved.platform,
        });

        expect(info.title.length).toBeGreaterThan(0);
        const options = bundle.engine.listQualityOptions(info);
        // The assertion that matters: an empty menu means the extractor changed
        // and the bot would show a card with no buttons.
        expect(options.length).toBeGreaterThan(0);
      },
    );
  }
});
