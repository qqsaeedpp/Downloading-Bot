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
import { createDownloaderEngine, YtDlpProcessError } from '@tgtools/downloader-engine';
import {
  CryptoIdGenerator,
  DownloadType,
  MediaKind,
  MediaPlatform,
  createNoopLogger,
} from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  YOUTUBE_BLOCKED_NO_FORMATS,
  YOUTUBE_SHORT,
  YOUTUBE_VIDEO,
  X_SINGLE_PHOTO_POST,
} from '../fixtures/x-posts.js';

const MB = 1024 * 1024;
const WATCH_URL = 'https://www.youtube.com/watch?v=9BrUmidnzo0';

class FixtureRunner implements YtDlpRunner {
  document: unknown = {};
  failure: Error | undefined;
  readonly dumpCalls: YtDlpInvocation[] = [];

  dumpJson(invocation: YtDlpInvocation): Promise<YtDlpResult> {
    this.dumpCalls.push(invocation);
    if (this.failure !== undefined) return Promise.reject(this.failure);
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
}

describe('YouTube inspection', () => {
  let downloadDir: string;
  let runner: FixtureRunner;
  let bundle: EngineBundle;

  beforeEach(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-yt-'));
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

  async function inspect(document: unknown, url = WATCH_URL) {
    runner.document = document;
    const info = await bundle.engine.inspect({ url, platform: MediaPlatform.YouTube });
    return { info, options: bundle.engine.listQualityOptions(info) };
  }

  it('offers video and audio for a normal long video', async () => {
    const { info, options } = await inspect(YOUTUBE_VIDEO);

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.filter((o) => o.type === DownloadType.Video).map((o) => o.label)).toEqual([
      '1080p',
      '360p',
    ]);
    expect(options.some((o) => o.type === DownloadType.Audio)).toBe(true);
    expect(options.some((o) => o.type === DownloadType.Image)).toBe(false);
  });

  it('offers video and audio for a Short', async () => {
    const { info, options } = await inspect(
      YOUTUBE_SHORT,
      'https://www.youtube.com/shorts/sH0rt1dAbCd',
    );

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.filter((o) => o.type === DownloadType.Video).map((o) => o.label)).toEqual([
      '1280p',
    ]);
    expect(options.some((o) => o.type === DownloadType.Image)).toBe(false);
  });

  it('never calls a video with a duration an image', async () => {
    // The reported bug: a 36-minute video was presented as "این پست یک تصویر
    // است" with only a "دریافت تصویر" button, because the formats were empty
    // and every YouTube video has a thumbnail. A still image has no duration.
    const { info, options } = await inspect(YOUTUBE_BLOCKED_NO_FORMATS);

    expect(info.durationSeconds).toBe(2200);
    expect(info.mediaKind).not.toBe(MediaKind.Image);
    expect(options.some((o) => o.type === DownloadType.Image)).toBe(false);
  });

  it('offers nothing rather than an option that cannot be delivered', async () => {
    // Zero formats means zero downloadable renditions. Advertising a "best"
    // button here would queue a job yt-dlp is guaranteed to refuse.
    const { options } = await inspect(YOUTUBE_BLOCKED_NO_FORMATS);
    expect(options).toEqual([]);
  });

  it('lets the real extractor error through instead of an empty document', async () => {
    // YouTube never serves a standalone still, so its inspection does not pass
    // `--ignore-no-formats-error`. Suppressing the failure is what turned a
    // legible "sign in to confirm you're not a bot" into a silent image offer.
    const inspectArgs = (
      await inspect(YOUTUBE_VIDEO).then(() => runner.dumpCalls[0]?.args ?? [])
    ).join(' ');
    expect(inspectArgs).not.toContain('--ignore-no-formats-error');

    runner.failure = new YtDlpProcessError(
      1,
      null,
      "ERROR: [youtube] 9BrUmidnzo0: Sign in to confirm you're not a bot. Use --cookies.",
    );

    await expect(
      bundle.engine.inspect({ url: WATCH_URL, platform: MediaPlatform.YouTube }),
    ).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('still tolerates a missing-format error on platforms that do serve images', async () => {
    // Pinterest and X genuinely publish stills, so their inspection must keep
    // the flag or an image-only post would abort instead of returning JSON.
    runner.document = X_SINGLE_PHOTO_POST;
    await bundle.engine.inspect({
      url: 'https://x.com/someone/status/1700000000000000003',
      platform: MediaPlatform.X,
    });

    const args = (runner.dumpCalls[0]?.args ?? []).join(' ');
    expect(args).toContain('--ignore-no-formats-error');
  });
});
