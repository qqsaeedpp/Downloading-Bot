import type { IdGenerator, Logger, MediaPlatform } from '@tgtools/shared';
import type { CookieProvider } from './cookies/cookie-provider.js';
import { NoCookieProvider } from './cookies/cookie-provider.js';
import { FileCookieProvider } from './cookies/file-cookie-provider.js';
import type { MediaEngine } from './engine-types.js';
import { Ffprobe } from './media/ffprobe.js';
import { ImageNormalizer } from './media/image-normalizer.js';
import { PlaybackNormalizer } from './media/playback-normalizer.js';
import { ThumbnailGenerator } from './media/thumbnail.js';
import type { PlatformRegistry } from './platforms/registry.js';
import { createPlatformRegistry } from './platforms/registry.js';
import { RedirectResolver } from './security/redirect-resolver.js';
import { UrlGuard } from './security/url-guard.js';
import { createWorkspaceFactory } from './workspace/job-workspace.js';
import type { WorkspaceFactory } from './workspace/job-workspace.js';
import type { YtDlpRunner } from './ytdlp/ytdlp-runner.port.js';
import { YtDlpNodeRunner } from './ytdlp/ytdlp-node-runner.js';
import { YtDlpMediaEngine } from './ytdlp/ytdlp-media-engine.js';

export interface EngineBinaries {
  readonly ytDlpPath: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** Defaults to `deno`, which is the only runtime yt-dlp enables by default. */
  readonly jsRuntimePath?: string;
}

export interface EngineLimits {
  readonly maxDownloadBytes: number;
  readonly maxTranscodeBytes: number;
  readonly minFreeDiskBytes: number;
  readonly inspectTimeoutMs: number;
  readonly downloadTimeoutMs: number;
  readonly ffmpegTimeoutMs: number;
  readonly ffprobeTimeoutMs: number;
}

export interface EngineFfmpegSettings {
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly preset: string;
  readonly crf: number;
}

export interface CreateEngineOptions {
  readonly binaries: EngineBinaries;
  readonly limits: EngineLimits;
  readonly ffmpeg: EngineFfmpegSettings;
  readonly downloadDirectory: string;
  readonly cookiePaths: Readonly<Partial<Record<MediaPlatform, string>>>;
  /** Operator escape hatches; see `ExtractionConfig`. */
  readonly extraction?: {
    readonly proxyUrl?: string | undefined;
    readonly extractorArgs?: Readonly<Partial<Record<MediaPlatform, string>>> | undefined;
    readonly potProviderUrl?: string | undefined;
  };
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  /** Overridden in tests with a scripted runner; production spawns yt-dlp. */
  readonly runner?: YtDlpRunner;
  readonly cookieProvider?: CookieProvider;
}

export interface EngineBundle {
  readonly engine: MediaEngine;
  readonly registry: PlatformRegistry;
  readonly urlGuard: UrlGuard;
  readonly redirectResolver: RedirectResolver;
  readonly workspaces: WorkspaceFactory;
}

/**
 * The engine's composition root.
 *
 * Everything is constructed here and handed down by reference; nothing in the
 * package reaches for a module-level singleton, which is what lets a test build
 * a second engine with a fake runner and a temporary directory without
 * disturbing the first.
 */
export function createDownloaderEngine(options: CreateEngineOptions): EngineBundle {
  const { binaries, limits, logger } = options;

  const registry = createPlatformRegistry();
  const urlGuard = new UrlGuard(registry);
  const redirectResolver = new RedirectResolver({ guard: urlGuard, logger });

  const ffprobe = new Ffprobe({
    ffprobePath: binaries.ffprobePath,
    timeoutMs: limits.ffprobeTimeoutMs,
    logger,
  });

  const normalizer = new PlaybackNormalizer(
    {
      ffmpegPath: binaries.ffmpegPath,
      timeoutMs: limits.ffmpegTimeoutMs,
      videoCodec: options.ffmpeg.videoCodec,
      audioCodec: options.ffmpeg.audioCodec,
      preset: options.ffmpeg.preset,
      crf: options.ffmpeg.crf,
      maxTranscodeBytes: limits.maxTranscodeBytes,
      logger,
    },
    ffprobe,
  );

  const imageNormalizer = new ImageNormalizer(
    { ffmpegPath: binaries.ffmpegPath, timeoutMs: limits.ffmpegTimeoutMs, logger },
    ffprobe,
  );

  const thumbnails = new ThumbnailGenerator({
    ffmpegPath: binaries.ffmpegPath,
    timeoutMs: limits.ffprobeTimeoutMs,
    logger,
  });

  const workspaces = createWorkspaceFactory({
    rootDirectory: options.downloadDirectory,
    logger,
    minFreeBytes: limits.minFreeDiskBytes,
  });

  const runner =
    options.runner ??
    new YtDlpNodeRunner({
      binaryPath: binaries.ytDlpPath,
      ffmpegPath: binaries.ffmpegPath,
      jsRuntimePath: binaries.jsRuntimePath ?? 'deno',
      logger,
    });

  const cookieProvider =
    options.cookieProvider ??
    (Object.keys(options.cookiePaths).length === 0
      ? new NoCookieProvider()
      : new FileCookieProvider({ paths: options.cookiePaths, logger }));

  const engine = new YtDlpMediaEngine({
    runner,
    registry,
    cookieProvider,
    workspaces,
    ffprobe,
    normalizer,
    imageNormalizer,
    thumbnails,
    idGenerator: options.idGenerator,
    logger,
    limits: {
      maxDownloadBytes: limits.maxDownloadBytes,
      inspectTimeoutMs: limits.inspectTimeoutMs,
      downloadTimeoutMs: limits.downloadTimeoutMs,
    },
    extraction: {
      proxyUrl: options.extraction?.proxyUrl,
      extractorArgs: options.extraction?.extractorArgs ?? {},
      potProviderUrl: options.extraction?.potProviderUrl,
    },
  });

  return { engine, registry, urlGuard, redirectResolver, workspaces };
}
