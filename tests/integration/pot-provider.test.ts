import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateEngineOptions,
  EngineBundle,
  YtDlpDownloadInvocation,
  YtDlpInvocation,
  YtDlpResult,
  YtDlpRunner,
} from '@tgtools/downloader-engine';
import { createDownloaderEngine } from '@tgtools/downloader-engine';
import { CryptoIdGenerator, DownloadType, MediaPlatform, createNoopLogger } from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTAGRAM_PHOTO_POST, YOUTUBE_VIDEO } from '../fixtures/x-posts.js';

const MB = 1024 * 1024;
const POT_URL = 'http://bgutil-provider:4416';

class RecordingRunner implements YtDlpRunner {
  document: unknown = {};
  readonly dumpCalls: YtDlpInvocation[] = [];

  dumpJson(invocation: YtDlpInvocation): Promise<YtDlpResult> {
    this.dumpCalls.push(invocation);
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
 * A PO token is what YouTube's "sign in to confirm you're not a bot" is actually
 * demanding, and a self-hosted provider answers it with no account and no paid
 * proxy. The plugin registers under its OWN extractor key, so this could not be
 * expressed through YOUTUBE_EXTRACTOR_ARGS — which hard-prefixes `youtube:`.
 */
describe('proof-of-origin token provider', () => {
  let downloadDir: string;
  let runner: RecordingRunner;

  beforeEach(async () => {
    downloadDir = await mkdtemp(join(tmpdir(), 'tgtools-pot-'));
    runner = new RecordingRunner();
  });

  afterEach(async () => {
    await rm(downloadDir, { recursive: true, force: true });
  });

  function build(extraction: CreateEngineOptions['extraction']): EngineBundle {
    return createDownloaderEngine({
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
      ...(extraction === undefined ? {} : { extraction }),
    });
  }

  /** The `--extractor-args` values, in order, from the last inspection. */
  function extractorArgsOf(invocation: YtDlpInvocation | undefined): string[] {
    const args = invocation?.args ?? [];
    return args.flatMap((arg, i) => (args[i - 1] === '--extractor-args' ? [arg] : []));
  }

  it('passes the provider base URL under its own extractor key', async () => {
    const bundle = build({ potProviderUrl: POT_URL });
    runner.document = YOUTUBE_VIDEO;

    await bundle.engine.inspect({
      url: 'https://www.youtube.com/watch?v=9BrUmidnzo0',
      platform: MediaPlatform.YouTube,
    });

    expect(extractorArgsOf(runner.dumpCalls[0])).toEqual([
      `youtubepot-bgutilhttp:base_url=${POT_URL}`,
    ]);
  });

  it('carries the provider alongside a player-client override, as two arguments', async () => {
    // The reason the field is a list. Both must survive: they address different
    // extractors, so folding them into one string would address neither.
    const bundle = build({
      potProviderUrl: POT_URL,
      extractorArgs: { [MediaPlatform.YouTube]: 'player_client=tv' },
    });
    runner.document = YOUTUBE_VIDEO;

    await bundle.engine.inspect({
      url: 'https://www.youtube.com/watch?v=9BrUmidnzo0',
      platform: MediaPlatform.YouTube,
    });

    expect(extractorArgsOf(runner.dumpCalls[0])).toEqual([
      'youtube:player_client=tv',
      `youtubepot-bgutilhttp:base_url=${POT_URL}`,
    ]);
  });

  it('sends nothing at all when no provider is configured', async () => {
    // The default. An operator who does not run a provider must not have an
    // argument pointing at a service that is not there.
    const bundle = build(undefined);
    runner.document = YOUTUBE_VIDEO;

    await bundle.engine.inspect({
      url: 'https://www.youtube.com/watch?v=9BrUmidnzo0',
      platform: MediaPlatform.YouTube,
    });

    expect(extractorArgsOf(runner.dumpCalls[0])).toEqual([]);
  });

  it('does not send it to platforms that have no PO token scheme', async () => {
    // The plugin only hooks YouTube. Instagram would ignore the argument, but
    // sending it would still be a lie about what we are asking for.
    const bundle = build({ potProviderUrl: POT_URL });
    runner.document = INSTAGRAM_PHOTO_POST;

    await bundle.engine.inspect({
      url: 'https://www.instagram.com/p/ABC123/',
      platform: MediaPlatform.Instagram,
    });

    expect(extractorArgsOf(runner.dumpCalls[0])).toEqual([]);
  });

  it('applies to downloads too, not just inspection', async () => {
    // A download that disagreed with the probe about how it authenticates is a
    // reliable way to produce "the formats it just offered me are gone".
    const bundle = build({ potProviderUrl: POT_URL });
    runner.document = YOUTUBE_VIDEO;

    const downloads: YtDlpDownloadInvocation[] = [];
    runner.download = (invocation) => {
      downloads.push(invocation);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, filePaths: [] });
    };

    // The download is expected to fail: the fixture runner produces no file.
    // Only the argument vector it was asked for matters here.
    await bundle.engine
      .download(
        {
          url: 'https://www.youtube.com/watch?v=9BrUmidnzo0',
          platform: MediaPlatform.YouTube,
          type: DownloadType.Video,
          quality: '1080p',
        },
        {},
      )
      .catch(() => undefined);

    const args = downloads[0]?.args ?? [];
    const values = args.flatMap((arg, i) => (args[i - 1] === '--extractor-args' ? [arg] : []));
    expect(values).toContain(`youtubepot-bgutilhttp:base_url=${POT_URL}`);
  });
});
