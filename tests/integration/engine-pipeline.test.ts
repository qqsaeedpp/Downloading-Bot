import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
  DownloadStage,
  DownloadType,
  MediaKind,
  MediaPlatform,
  createNoopLogger,
} from '@tgtools/shared';
import type { DownloadProgress } from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MB = 1024 * 1024;

/**
 * A yt-dlp that never runs.
 *
 * It writes whatever the test says into the workspace and reports whatever the
 * test says on stdout, which is enough to exercise everything above the
 * process boundary: the selector, the mapper, the stale-cookie retry, the
 * output discovery, the error mapping and the cleanup guarantee.
 */
class ScriptedRunner implements YtDlpRunner {
  infoDocument: unknown = {};
  /** Thrown instead of succeeding, to drive the error paths. */
  failure: Error | undefined;
  /** Written into the workspace as if yt-dlp had produced it. */
  producedFile: { name: string; bytes: number } | undefined;
  progressSamples: DownloadProgress[] = [];
  readonly dumpCalls: YtDlpInvocation[] = [];
  readonly downloadCalls: YtDlpDownloadInvocation[] = [];

  dumpJson(invocation: YtDlpInvocation): Promise<YtDlpResult> {
    this.dumpCalls.push(invocation);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({
      stdout: JSON.stringify(this.infoDocument),
      stderr: '',
      exitCode: 0,
      filePaths: [],
    });
  }

  async download(invocation: YtDlpDownloadInvocation): Promise<YtDlpResult> {
    this.downloadCalls.push(invocation);
    for (const sample of this.progressSamples) invocation.onProgress?.(sample);
    if (this.failure !== undefined) throw this.failure;

    const produced = this.producedFile;
    if (produced === undefined) {
      return { stdout: '', stderr: '', exitCode: 0, filePaths: [] };
    }

    // The output template is `<workspace>/%(id).100s.%(ext)s`; take its
    // directory and drop the file there, exactly as yt-dlp would. `dirname`
    // rather than a manual slice, so this works on both path separators.
    const outputIndex = invocation.args.indexOf('--output');
    const template = invocation.args[outputIndex + 1] ?? '';
    const path = join(dirname(template), produced.name);
    await writeFile(path, Buffer.alloc(produced.bytes));
    return { stdout: '', stderr: '', exitCode: 0, filePaths: [path] };
  }

  version(): Promise<string | undefined> {
    return Promise.resolve('2026.01.01');
  }

  jsRuntimeVersion(): Promise<string | undefined> {
    return Promise.resolve('deno 2.9.4');
  }
}

const REEL_INFO = {
  id: 'Cx1y2z3AbCd',
  title: 'A reel',
  uploader: 'someone',
  duration: 27,
  thumbnail: 'https://cdn.test/t.jpg',
  upload_date: '20260131',
  view_count: 4_200,
  formats: [
    {
      format_id: '137',
      ext: 'mp4',
      height: 1080,
      width: 1920,
      vcodec: 'avc1.640028',
      acodec: 'none',
      filesize: 20 * MB,
      tbr: 2_500,
    },
    {
      format_id: '140',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      abr: 128,
      filesize: 1 * MB,
    },
  ],
};

describe('the engine pipeline, above the process boundary', () => {
  let downloadDir: string;
  let runner: ScriptedRunner;
  let bundle: EngineBundle;

  beforeEach(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-engine-test-'));
    runner = new ScriptedRunner();
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

  it('turns an extractor document into a media description', async () => {
    runner.infoDocument = REEL_INFO;

    const info = await bundle.engine.inspect({
      url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
      platform: MediaPlatform.Instagram,
    });

    expect(info.title).toBe('A reel');
    expect(info.mediaKind).toBe(MediaKind.Video);
    expect(info.uploadDate).toBe('2026-01-31');
    expect(info.obtainedWithCookies).toBe(false);
  });

  it('derives a quality menu from what the source actually offers', async () => {
    runner.infoDocument = REEL_INFO;
    const info = await bundle.engine.inspect({
      url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
      platform: MediaPlatform.Instagram,
    });

    const options = bundle.engine.listQualityOptions(info);
    expect(
      options.filter((option) => option.type === DownloadType.Video).map((o) => o.label),
    ).toEqual(['1080p']);
    // The source declares 128 kbps, so 320 must not be offered.
    expect(
      options.filter((option) => option.type === DownloadType.Audio).map((o) => o.audioBitrateKbps),
    ).toEqual([128]);
  });

  it('offers a single image option for an image-only pin', async () => {
    runner.infoDocument = {
      id: 'pin1',
      title: 'A pin',
      thumbnail: 'https://cdn.test/p.jpg',
      formats: [],
    };
    const info = await bundle.engine.inspect({
      url: 'https://www.pinterest.com/pin/1234567890/',
      platform: MediaPlatform.Pinterest,
    });

    const options = bundle.engine.listQualityOptions(info);
    expect(options).toHaveLength(1);
    expect(options[0]?.type).toBe(DownloadType.Image);
  });

  it('passes the requested height into the format selector', async () => {
    runner.producedFile = { name: 'Cx1y2z3AbCd.mp4', bytes: 2_048 };

    await bundle.engine.download(
      {
        url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
        platform: MediaPlatform.Instagram,
        type: DownloadType.Video,
        quality: '720p',
      },
      {},
    );

    const selector = runner.downloadCalls[0]?.formatSelector ?? '';
    expect(selector).toContain('[height=720]');
  });

  it('takes the progressive shortcut for Instagram only when no height was asked for', async () => {
    runner.producedFile = { name: 'Cx1y2z3AbCd.mp4', bytes: 2_048 };

    await bundle.engine.download(
      {
        url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
        platform: MediaPlatform.Instagram,
        type: DownloadType.Video,
      },
      {},
    );
    // Instagram's pre-muxed copy declares no height, so the first candidate
    // must carry no height filter.
    expect(runner.downloadCalls[0]?.formatSelector?.split('/')[0]).not.toContain('height');

    await bundle.engine.download(
      {
        url: 'https://www.tiktok.com/@a/video/7234567890123456789',
        platform: MediaPlatform.TikTok,
        type: DownloadType.Video,
      },
      {},
    );
    // TikTok's labelled formats are the good ones; no shortcut applies.
    expect(runner.downloadCalls[1]?.formatSelector?.split('/')[0]).toContain('bv*');
  });

  it('reports progress and stages to the caller', async () => {
    runner.producedFile = { name: 'Cx1y2z3AbCd.mp4', bytes: 2_048 };
    runner.progressSamples = [
      { downloadedBytes: 512, totalBytes: 2_048, percent: 25 },
      { downloadedBytes: 2_048, totalBytes: 2_048, percent: 100 },
    ];

    const stages: string[] = [];
    const progress: DownloadProgress[] = [];

    await bundle.engine.download(
      {
        url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
        platform: MediaPlatform.Instagram,
        type: DownloadType.Video,
      },
      {
        onStageChange: (stage) => {
          stages.push(stage);
        },
        onProgress: (sample) => {
          progress.push(sample);
        },
      },
    );

    expect(stages).toContain(DownloadStage.Preparing);
    expect(stages).toContain(DownloadStage.Downloading);
    expect(progress).toHaveLength(2);
  });

  it('hands back a file that is really on disk, and removes it on cleanup', async () => {
    runner.producedFile = { name: 'Cx1y2z3AbCd.mp4', bytes: 4_096 };

    const media = await bundle.engine.download(
      {
        url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
        platform: MediaPlatform.Instagram,
        type: DownloadType.Video,
      },
      {},
    );

    expect(media.fileSize).toBe(4_096);
    expect(media.mimeType).toBe('video/mp4');
    await expect(stat(media.filePath)).resolves.toBeDefined();

    await media.cleanup();
    await expect(stat(media.filePath)).rejects.toThrow();
  });

  it('removes the workspace when the download fails', async () => {
    runner.failure = new YtDlpProcessError(1, null, 'ERROR: Video unavailable');

    await expect(
      bundle.engine.download(
        {
          url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
          platform: MediaPlatform.Instagram,
          type: DownloadType.Video,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });

    // A failed run leaves partial files behind; dropping the whole workspace is
    // what keeps a busy volume from filling with the debris of every failure.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(downloadDir)).toEqual([]);
  });

  it('reports a run that produced nothing as a format problem, not a crash', async () => {
    runner.producedFile = undefined;

    await expect(
      bundle.engine.download(
        {
          url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
          platform: MediaPlatform.Instagram,
          type: DownloadType.Video,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'FORMAT_UNAVAILABLE' });
  });

  it('maps an auth wall to a domain code rather than leaking the message', async () => {
    runner.failure = new YtDlpProcessError(
      1,
      null,
      'ERROR: [Instagram] Requested content is not available, rate-limit reached or login required',
    );

    await expect(
      bundle.engine.inspect({
        url: 'https://www.instagram.com/reel/Cx1y2z3AbCd/',
        platform: MediaPlatform.Instagram,
      }),
    ).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  });

  it('refuses a URL that is not a supported post before anything runs', () => {
    expect(() => bundle.urlGuard.parse('http://169.254.169.254/latest/meta-data/')).toThrow();
    expect(runner.dumpCalls).toHaveLength(0);
  });
});
