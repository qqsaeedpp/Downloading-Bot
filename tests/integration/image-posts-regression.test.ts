import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  EngineBundle,
  YtDlpDownloadInvocation,
  YtDlpInvocation,
  YtDlpResult,
  YtDlpRunner,
} from '@tgtools/downloader-engine';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import {
  CryptoIdGenerator,
  DownloadType,
  MediaKind,
  MediaPlatform,
  createNoopLogger,
} from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTAGRAM_PHOTO_POST,
  TIKTOK_PHOTO_POST,
  TIKTOK_VIDEO_POST,
  X_SINGLE_PHOTO_POST,
} from '../fixtures/x-posts.js';

const MB = 1024 * 1024;

class FixtureRunner implements YtDlpRunner {
  document: unknown = {};

  dumpJson(_invocation: YtDlpInvocation): Promise<YtDlpResult> {
    return Promise.resolve({
      stdout: JSON.stringify(this.document),
      stderr: '',
      exitCode: 0,
      filePaths: [],
    });
  }

  download(_invocation: YtDlpDownloadInvocation): Promise<YtDlpResult> {
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, filePaths: [] });
  }

  version(): Promise<string | undefined> {
    return Promise.resolve('2026.07.04');
  }

  jsRuntimeVersion(): Promise<string | undefined> {
    return Promise.resolve('deno 2.9.4');
  }
}

/**
 * The duration-implies-video rule was introduced to stop a blocked YouTube
 * extraction being offered as a still. It was written unscoped, so it also fired
 * on the platforms that genuinely publish stills — and a TikTok slideshow set to
 * a song reports the song's duration. The result was an empty quality keyboard
 * on posts that had worked since the first release.
 */
describe('a platform that publishes stills keeps publishing them', () => {
  let downloadDir: string;
  let runner: FixtureRunner;
  let bundle: EngineBundle;

  beforeEach(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-img-'));
    runner = new FixtureRunner();
    bundle = createDownloaderEngine({
      binaries: { ytDlpPath: 'yt-dlp', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' },
      limits: {
        maxDownloadBytes: 500 * MB,
        maxTranscodeBytes: 250 * MB,
        minFreeDiskBytes: 0,
        inspectTimeoutMs: 5_000,
        downloadTimeoutMs: 10_000,
        ffmpegTimeoutMs: 5_000,
        ffprobeTimeoutMs: 5_000,
      },
      ffmpeg: { videoCodec: 'libx264', audioCodec: 'aac', preset: 'veryfast', crf: 23 },
      downloadDirectory: downloadDir,
      cookiePaths: {},
      idGenerator: new CryptoIdGenerator(),
      logger: createNoopLogger(),
      runner,
    });
  });

  afterEach(async () => {
    await rm(downloadDir, { recursive: true, force: true });
  });

  async function inspect(document: unknown, platform: MediaPlatform, url: string) {
    runner.document = document;
    const info = await bundle.engine.inspect({ url, platform });
    return { info, options: bundle.engine.listQualityOptions(info) };
  }

  it('offers a TikTok photo slideshow as an image despite its music duration', async () => {
    const { info, options } = await inspect(
      TIKTOK_PHOTO_POST,
      MediaPlatform.TikTok,
      'https://www.tiktok.com/@someone/photo/7300000000000000001',
    );

    // The slideshow reports 15 seconds of audio. It is still a set of pictures.
    expect(info.durationSeconds).toBe(15);
    expect(info.mediaKind).toBe(MediaKind.Image);
    expect(options.map((o) => o.type)).toEqual([DownloadType.Image]);
  });

  it('offers an Instagram photo post as an image despite its reported duration', async () => {
    const { info, options } = await inspect(
      INSTAGRAM_PHOTO_POST,
      MediaPlatform.Instagram,
      'https://www.instagram.com/p/ABC123/',
    );

    expect(info.mediaKind).toBe(MediaKind.Image);
    expect(options.map((o) => o.type)).toEqual([DownloadType.Image]);
  });

  it('never returns an empty keyboard for a post that has pictures', async () => {
    // The exact user-visible symptom: no buttons at all, and one layer up an
    // "no downloadable content found" error on a post that plainly has content.
    for (const [document, platform, url] of [
      [
        TIKTOK_PHOTO_POST,
        MediaPlatform.TikTok,
        'https://www.tiktok.com/@a/photo/7300000000000000001',
      ],
      [INSTAGRAM_PHOTO_POST, MediaPlatform.Instagram, 'https://www.instagram.com/p/ABC123/'],
      [X_SINGLE_PHOTO_POST, MediaPlatform.X, 'https://x.com/someone/status/1700000000000000003'],
    ] as const) {
      const { options } = await inspect(document, platform, url);
      expect(options.length, `${platform} returned no options`).toBeGreaterThan(0);
    }
  });

  it('still treats an ordinary TikTok video as a video', async () => {
    // The fix must not buy the slideshow back by breaking the common case.
    const { info, options } = await inspect(
      TIKTOK_VIDEO_POST,
      MediaPlatform.TikTok,
      'https://www.tiktok.com/@someone/video/7300000000000000002',
    );

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.some((o) => o.type === DownloadType.Video)).toBe(true);
    expect(options.some((o) => o.type === DownloadType.Image)).toBe(false);
  });
});
