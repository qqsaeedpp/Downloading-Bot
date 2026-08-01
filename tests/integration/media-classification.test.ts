import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  X_GIF_POST,
  X_MIXED_MEDIA_POST,
  X_MULTI_PHOTO_POST,
  X_SINGLE_PHOTO_POST,
  X_TEXT_ONLY_POST,
  X_VIDEO_POST,
  YOUTUBE_VIDEO,
} from '../fixtures/x-posts.js';

const MB = 1024 * 1024;

/** Replays a captured yt-dlp document instead of spawning anything. */
class FixtureRunner implements YtDlpRunner {
  document: unknown = {};
  producedFile: { name: string; bytes: number } | undefined;
  readonly downloadCalls: YtDlpDownloadInvocation[] = [];

  dumpJson(_invocation: YtDlpInvocation): Promise<YtDlpResult> {
    return Promise.resolve({
      stdout: JSON.stringify(this.document),
      stderr: '',
      exitCode: 0,
      filePaths: [],
    });
  }

  async download(invocation: YtDlpDownloadInvocation): Promise<YtDlpResult> {
    this.downloadCalls.push(invocation);
    const produced = this.producedFile;
    if (produced === undefined) return { stdout: '', stderr: '', exitCode: 0, filePaths: [] };
    const outputIndex = invocation.args.indexOf('--output');
    const template = invocation.args[outputIndex + 1] ?? '';
    const path = join(dirname(template), produced.name);
    await writeFile(path, Buffer.alloc(produced.bytes));
    return { stdout: '', stderr: '', exitCode: 0, filePaths: [path] };
  }

  version(): Promise<string | undefined> {
    return Promise.resolve('2026.07.04');
  }

  jsRuntimeVersion(): Promise<string | undefined> {
    return Promise.resolve('deno 2.9.4');
  }
}

describe('media classification against captured extractor output', () => {
  let downloadDir: string;
  let runner: FixtureRunner;
  let bundle: EngineBundle;

  beforeEach(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-classify-'));
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

  const X_URL = 'https://x.com/someone/status/1700000000000000001';

  it('offers video and audio for an X video post', async () => {
    const { info, options } = await inspect(X_VIDEO_POST, MediaPlatform.X, X_URL);

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.filter((o) => o.type === DownloadType.Video).map((o) => o.label)).toEqual([
      '720p',
      '270p',
    ]);
    expect(options.some((o) => o.type === DownloadType.Audio)).toBe(true);
  });

  it('offers no audio for a tweeted GIF, which has no audio track', async () => {
    const { info, options } = await inspect(X_GIF_POST, MediaPlatform.X, X_URL);

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.filter((o) => o.type === DownloadType.Video)).not.toHaveLength(0);
    // `acodec: "none"` is a declaration of absence. Offering an extraction
    // would queue a job yt-dlp can only refuse.
    expect(options.filter((o) => o.type === DownloadType.Audio)).toEqual([]);
  });

  it('offers an image download for a single-photo tweet, never audio', async () => {
    const { info, options } = await inspect(X_SINGLE_PHOTO_POST, MediaPlatform.X, X_URL);

    // This is the reported bug: mediaKind came back `unknown` and the menu
    // carried "128 kbps" and "192 kbps".
    expect(info.mediaKind).toBe(MediaKind.Image);
    expect(options).toHaveLength(1);
    expect(options[0]?.type).toBe(DownloadType.Image);
    expect(options.some((o) => o.type === DownloadType.Audio)).toBe(false);
  });

  it('takes the first item of a multi-photo tweet and offers it as an image', async () => {
    const { info, options } = await inspect(X_MULTI_PHOTO_POST, MediaPlatform.X, X_URL);

    expect(info.mediaKind).toBe(MediaKind.Image);
    expect(options.map((o) => o.type)).toEqual([DownloadType.Image]);
  });

  it('offers the video from a tweet that mixes a photo and a video', async () => {
    const { info, options } = await inspect(X_MIXED_MEDIA_POST, MediaPlatform.X, X_URL);

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(options.some((o) => o.type === DownloadType.Video)).toBe(true);
  });

  it('refuses a text-only tweet with a typed unsupported-media error', async () => {
    runner.document = X_TEXT_ONLY_POST;
    const info = await bundle.engine.inspect({ url: X_URL, platform: MediaPlatform.X });

    // Nothing to download, and no invented option. The empty list is what the
    // use case turns into UNSUPPORTED_MEDIA.
    expect(bundle.engine.listQualityOptions(info)).toEqual([]);
  });

  it('never offers an option whose download selector could not succeed', async () => {
    for (const document of [X_SINGLE_PHOTO_POST, X_MULTI_PHOTO_POST, X_TEXT_ONLY_POST]) {
      runner.document = document;
      const info = await bundle.engine.inspect({ url: X_URL, platform: MediaPlatform.X });
      const options = bundle.engine.listQualityOptions(info);
      expect(options.every((o) => o.type !== DownloadType.Audio)).toBe(true);
      expect(options.every((o) => o.type !== DownloadType.Video)).toBe(true);
    }
  });

  it('carries an image selection through to a real downloaded file', async () => {
    runner.document = X_SINGLE_PHOTO_POST;
    runner.producedFile = { name: '1700000000000000003.jpg', bytes: 2_048 };

    const info = await bundle.engine.inspect({ url: X_URL, platform: MediaPlatform.X });
    const option = bundle.engine.listQualityOptions(info)[0];
    expect(option?.type).toBe(DownloadType.Image);

    const media = await bundle.engine.download(
      { url: X_URL, platform: MediaPlatform.X, type: DownloadType.Image },
      {},
    );

    expect(media.mimeType).toBe('image/jpeg');
    expect(media.fileSize).toBe(2_048);
    // The image path must use --write-thumbnail, not a video format selector.
    expect(runner.downloadCalls[0]?.args).toContain('--write-thumbnail');
    expect(runner.downloadCalls[0]?.formatSelector).toBeUndefined();
    await media.cleanup();
  });

  it('offers real YouTube video and audio qualities', async () => {
    const { info, options } = await inspect(
      YOUTUBE_VIDEO,
      MediaPlatform.YouTube,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );

    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(info.title).toBe('A YouTube video');
    expect(info.uploader).toBe('Some Channel');
    expect(options.filter((o) => o.type === DownloadType.Video).map((o) => o.label)).toEqual([
      '1080p',
      '360p',
    ]);
    // The source declares 128 kbps, so the ladder stops there.
    expect(
      options.filter((o) => o.type === DownloadType.Audio).map((o) => o.audioBitrateKbps),
    ).toEqual([128]);
  });
});
