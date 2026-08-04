import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { DownloadStage, DownloadType, MediaKind } from '@tgtools/shared';
import type { DownloadProgress, IdGenerator, Logger, MediaPlatform } from '@tgtools/shared';
import {
  assertContainedPath,
  createAbortScope,
  describeError,
  formatBytes,
  redactUrl,
  sanitizeFilename,
  throwIfAborted,
} from '@tgtools/shared';
import { withCookieFile } from '../cookies/cookie-file.js';
import type { CookieProvider } from '../cookies/cookie-provider.js';
import type {
  EngineDownloadContext,
  EngineDownloadRequest,
  EngineDownloadedMedia,
  EngineInspectRequest,
  EngineMediaInfo,
  EngineQualityOption,
  EngineVideoMetadata,
  MediaEngine,
  ToolchainInfo,
} from '../engine-types.js';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import { YtDlpErrorMapper } from '../errors/ytdlp-error-mapper.js';
import type { Ffprobe } from '../media/ffprobe.js';
import type { ImageNormalizer } from '../media/image-normalizer.js';
import { mimeTypeForPath } from '../media/mime.js';
import { planNormalization } from '../media/playback-normalizer.js';
import type { NormalizationPlan, PlaybackNormalizer } from '../media/playback-normalizer.js';
import type { ThumbnailGenerator } from '../media/thumbnail.js';
import type { PlatformDownloadPolicy } from '../platforms/platform-definition.js';
import type { PlatformRegistry } from '../platforms/registry.js';
import type { JobWorkspace, WorkspaceFactory } from '../workspace/job-workspace.js';
import { startSizeWatchdog } from '../workspace/size-watchdog.js';
import {
  buildAudioDownloadArgs,
  buildImageDownloadArgs,
  buildInspectArgs,
  buildVideoDownloadArgs,
} from './args-builder.js';
import {
  YtDlpFormatSelector,
  parseRequestedBitrate,
  parseRequestedHeight,
} from './format-selector.js';
import { YtDlpInfoMapper } from './info-mapper.js';
import { withStaleCookieRetry } from './stale-cookie-retry.js';
import type { YtDlpRunner } from './ytdlp-runner.port.js';
import { YtDlpProcessError } from './ytdlp-runner.port.js';

export interface YtDlpMediaEngineOptions {
  readonly runner: YtDlpRunner;
  readonly registry: PlatformRegistry;
  readonly cookieProvider: CookieProvider;
  readonly workspaces: WorkspaceFactory;
  readonly ffprobe: Ffprobe;
  readonly normalizer: PlaybackNormalizer;
  readonly imageNormalizer: ImageNormalizer;
  readonly thumbnails: ThumbnailGenerator;
  readonly idGenerator: IdGenerator;
  readonly logger: Logger;
  readonly limits: {
    readonly maxDownloadBytes: number;
    readonly inspectTimeoutMs: number;
    readonly downloadTimeoutMs: number;
  };
  readonly extraction?: {
    readonly proxyUrl?: string | undefined;
    readonly extractorArgs?: Readonly<Partial<Record<MediaPlatform, string>>> | undefined;
    /** Base URL of a running proof-of-origin token provider, if any. */
    readonly potProviderUrl?: string | undefined;
  };
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

/**
 * Composes the pieces into the two operations the rest of the system asks for:
 * "what is this link" and "fetch it".
 *
 * Everything technical lives below here — selector chains, watchdogs, ffmpeg —
 * and nothing above knows about any of it. The engine, in turn, knows nothing
 * about Telegram, users, jobs or Persian.
 */
export class YtDlpMediaEngine implements MediaEngine {
  readonly #selector = new YtDlpFormatSelector();
  readonly #mapper: YtDlpInfoMapper;
  readonly #errors = new YtDlpErrorMapper();

  constructor(private readonly options: YtDlpMediaEngineOptions) {
    this.#mapper = new YtDlpInfoMapper(options.logger);
  }

  /**
   * The operator's escape hatches, resolved for one platform.
   *
   * `--extractor-args` needs yt-dlp's own name for the extractor, which is not
   * always our slug: X is `twitter` to yt-dlp. The policy carries that mapping
   * so the environment variable stays simple — `player_client=android_vr`, not
   * `youtube:player_client=android_vr`.
   */
  #extractionArgs(policy: PlatformDownloadPolicy): {
    proxyUrl: string | undefined;
    extractorArgs: readonly string[];
  } {
    const extractorArgs: string[] = [];

    const configured = this.options.extraction?.extractorArgs?.[policy.platform];
    if (configured !== undefined) {
      extractorArgs.push(`${policy.ytdlpExtractorKey}:${configured}`);
    }

    // The PO token provider registers under its OWN extractor key, so this is a
    // second `--extractor-args` rather than part of the entry above. Emitted
    // only where the platform has such a scheme and the operator is running one.
    const potUrl = this.options.extraction?.potProviderUrl;
    if (potUrl !== undefined && policy.potProviderExtractorKey !== undefined) {
      extractorArgs.push(`${policy.potProviderExtractorKey}:base_url=${potUrl}`);
    }

    return { proxyUrl: this.options.extraction?.proxyUrl, extractorArgs };
  }

  async inspect(request: EngineInspectRequest): Promise<EngineMediaInfo> {
    const policy = this.options.registry.get(request.platform).createPolicy();
    const cookies =
      request.cookies ?? (await this.options.cookieProvider.getCookies(request.platform));

    const scope = createAbortScope({
      parent: request.signal,
      timeoutMs: this.options.limits.inspectTimeoutMs,
      label: 'media-inspect',
    });

    try {
      return await withStaleCookieRetry(
        {
          cookies,
          allowRetry: policy.retryWithoutCookies,
          logger: this.options.logger,
          platform: request.platform,
        },
        async (effectiveCookies) =>
          withCookieFile(effectiveCookies, async (cookiePath) => {
            const result = await this.options.runner.dumpJson({
              url: request.url,
              args: buildInspectArgs({
                cookiePath,
                platformExtraArgs: policy.extraArgs,
                ignoreNoFormatsError: policy.servesStandaloneImages,
                ...this.#extractionArgs(policy),
              }),
              signal: scope.signal,
            });

            const document = parseJsonDocument(result.stdout);
            return this.#mapper.map(document, {
              sourceUrl: request.url,
              platform: request.platform,
              obtainedWithCookies: effectiveCookies !== undefined,
              canBeImage: policy.servesStandaloneImages,
            });
          }),
      );
    } catch (error: unknown) {
      throw this.#toEngineError(error, EngineFailureCode.DownloadFailed);
    } finally {
      scope.dispose();
    }
  }

  listQualityOptions(info: EngineMediaInfo): readonly EngineQualityOption[] {
    const policy = this.options.registry.get(info.platform).createPolicy();

    if (info.mediaKind === MediaKind.Image || (policy.imageFirst && info.formats.length === 0)) {
      return [
        {
          id: 'image',
          type: DownloadType.Image,
          label: 'image',
          height: undefined,
          audioBitrateKbps: undefined,
          estimatedBytes: undefined,
          formatId: undefined,
        },
      ];
    }

    const video = this.#selector.listVideoOptions(
      info.formats,
      this.options.limits.maxDownloadBytes,
      info.durationSeconds,
    );
    const audio = policy.supportsAudioExtraction
      ? this.#selector.listAudioOptions(info.formats, info.durationSeconds, info.mediaKind)
      : [];

    // A video post whose renditions are present but unlabelled is not a failure
    // yet — Instagram's pre-muxed file has no height at all, and the download
    // chain's lenient tail will still find it — so offer a single "best" entry.
    //
    // `formats.length > 0` is the load-bearing part. With NO formats there is
    // nothing to fall back to, and a "best" button would queue a job yt-dlp is
    // guaranteed to refuse. That is the state a blocked YouTube extraction
    // leaves behind.
    if (video.length === 0 && info.mediaKind === MediaKind.Video && info.formats.length > 0) {
      return [
        {
          id: 'vbest',
          type: DownloadType.Video,
          label: 'best',
          height: undefined,
          audioBitrateKbps: undefined,
          estimatedBytes: undefined,
          formatId: undefined,
        },
        ...audio,
      ];
    }

    return [...video, ...audio];
  }

  async download(
    request: EngineDownloadRequest,
    context: EngineDownloadContext,
  ): Promise<EngineDownloadedMedia> {
    const policy = this.options.registry.get(request.platform).createPolicy();
    const workspace = await this.options.workspaces.create(this.options.idGenerator.uuid());

    const scope = createAbortScope({
      parent: context.signal,
      timeoutMs: this.options.limits.downloadTimeoutMs,
      label: 'media-download',
    });

    // The second tier of the size limit. `--max-filesize` only fires when the
    // extractor declared a size up front, and Instagram, TikTok and every HLS
    // stream declare nothing at all.
    const watchdog = startSizeWatchdog({
      workspace,
      maxBytes: this.options.limits.maxDownloadBytes,
      logger: this.options.logger,
      onExceeded: (error) => {
        scope.abort(error);
      },
    });

    try {
      await context.onStageChange?.(DownloadStage.Preparing);
      const cookies = await this.options.cookieProvider.getCookies(request.platform);
      this.#assertEstimatedSizeFits(request);

      const producedPath = await withStaleCookieRetry(
        {
          cookies,
          allowRetry: policy.retryWithoutCookies,
          logger: this.options.logger,
          platform: request.platform,
        },
        (effectiveCookies) =>
          withCookieFile(effectiveCookies, (cookiePath) =>
            this.#runDownload(
              request,
              workspace,
              cookiePath,
              policy.extraArgs,
              scope.signal,
              context,
            ),
          ),
      );

      throwIfAborted(scope.signal);
      const media = await this.#finalise(request, workspace, producedPath, scope.signal, context);
      this.options.logger.info('download completed', {
        platform: request.platform,
        type: request.type,
        url: redactUrl(request.url),
        bytes: media.fileSize,
      });
      return media;
    } catch (error: unknown) {
      // A failed or watchdog-killed run leaves partial files behind. Dropping
      // the whole workspace here is what keeps a busy volume from filling with
      // the debris of every failure.
      await workspace.cleanup();
      throw this.#toEngineError(error, EngineFailureCode.DownloadFailed);
    } finally {
      watchdog.stop();
      scope.dispose();
    }
  }

  /**
   * The first tier of the size limit: refuse before a single byte is pulled.
   *
   * The other two both fire late. `--max-filesize` needs the extractor to have
   * declared a size up front, and the watchdog only notices once the bytes are
   * already on disk — after minutes of transfer, and after the user has watched
   * a progress bar climb towards a file they were never going to receive.
   * Asking first turns that into an immediate refusal that names the real
   * reason, instead of a generic "download failed" at the end.
   *
   * An unknown estimate must NOT block the download. Instagram and TikTok
   * declare neither a size nor a bitrate, so no number at all is the normal
   * case rather than a suspicious one, and the runtime watchdog is the existing
   * backstop for exactly that. The same rule covers a pre-flight that fails
   * outright: whatever is wrong with the post will surface from the download
   * itself, with a better message than anything guessable from here.
   */
  #assertEstimatedSizeFits(request: EngineDownloadRequest): void {
    // Video only. An audio download is re-encoded to the bitrate the user asked
    // for, so the source rendition's size says little about what lands on disk,
    // and an image is a single still.
    if (request.type !== DownloadType.Video) return;

    // Deliberately NOT re-extracting to compute this.
    //
    // The number already exists: `listQualityOptions` estimated it to label the
    // button the user pressed, and it rides along on the request. Asking the
    // extractor again would double the extraction count of every video job — and
    // extraction is precisely what YouTube rate-limits and answers with a bot
    // check, so the pre-flight could fail a download that would have succeeded.
    // A cheap guard must not be able to cost more than the thing it guards.
    const estimatedBytes = request.estimatedBytes;
    const maxBytes = this.options.limits.maxDownloadBytes;
    if (estimatedBytes === undefined || estimatedBytes <= maxBytes) return;

    throw new EngineError(
      EngineFailureCode.MediaTooLarge,
      `The selected rendition is about ${formatBytes(estimatedBytes)}, over the ` +
        `${formatBytes(maxBytes)} download ceiling`,
      { context: { estimatedBytes, maxBytes } },
    );
  }

  async probeToolchain(): Promise<ToolchainInfo> {
    const [ytDlpVersion, ffmpegVersion, ffprobeVersion, jsRuntimeVersion] = await Promise.all([
      this.options.runner.version(),
      this.options.normalizer.version(),
      this.options.ffprobe.version(),
      this.options.runner.jsRuntimeVersion(),
    ]);
    return { ytDlpVersion, ffmpegVersion, ffprobeVersion, jsRuntimeVersion };
  }

  async #runDownload(
    request: EngineDownloadRequest,
    workspace: JobWorkspace,
    cookiePath: string | undefined,
    platformExtraArgs: readonly string[],
    signal: AbortSignal,
    context: EngineDownloadContext,
  ): Promise<string> {
    const outputTemplate = workspace.createOutputTemplate();
    const maxBytes = this.options.limits.maxDownloadBytes;
    // The same proxy and extractor arguments the inspection used. A download
    // that disagreed with the probe about how to reach the site would be a
    // reliable way to produce "the formats it offered me are gone".
    const extraction = this.#extractionArgs(
      this.options.registry.get(request.platform).createPolicy(),
    );
    const onProgress = (progress: DownloadProgress): void => {
      // Defence in depth. The caller is expected to absorb its own failures —
      // `ProgressWriter` does — but a progress callback rejecting here would
      // become an unhandled rejection, and the worker treats those as fatal.
      // Progress is never worth a job.
      void Promise.resolve(context.onProgress?.(progress)).catch((error: unknown) => {
        this.options.logger.debug('progress callback failed', { error: describeError(error) });
      });
    };

    await context.onStageChange?.(DownloadStage.Downloading);

    switch (request.type) {
      case DownloadType.Video: {
        const result = await this.options.runner.download({
          url: request.url,
          formatSelector: this.#buildVideoSelector(request),
          args: buildVideoDownloadArgs({
            ...extraction,
            cookiePath,
            platformExtraArgs,
            outputTemplate,
            maxBytes,
          }),
          signal,
          onProgress,
        });
        return this.#firstProducedFile(result.filePaths, workspace, undefined);
      }

      case DownloadType.Audio: {
        const bitrate = parseRequestedBitrate(request.quality) ?? 192;
        const result = await this.options.runner.download({
          url: request.url,
          formatSelector: this.#selector.buildAudioSelector({
            targetBitrateKbps: bitrate,
            maxBytes,
          }),
          args: buildAudioDownloadArgs({
            ...extraction,
            cookiePath,
            platformExtraArgs,
            outputTemplate,
            maxBytes,
            bitrateKbps: bitrate,
          }),
          signal,
          onProgress,
        });
        // The post-processor renames the file, so yt-dlp's reported path can
        // point at the pre-conversion original; prefer what is on disk.
        return this.#firstProducedFile(result.filePaths, workspace, new Set(['.mp3', '.m4a']));
      }

      case DownloadType.Image: {
        await this.options.runner.download({
          url: request.url,
          formatSelector: undefined,
          args: buildImageDownloadArgs({
            ...extraction,
            cookiePath,
            platformExtraArgs,
            outputTemplate,
          }),
          signal,
          onProgress,
        });
        // `--write-thumbnail` produces a sidecar that yt-dlp does not report in
        // `filePaths` — that field only ever carries the main media file — so
        // the image has to be found on disk.
        return this.#firstProducedFile([], workspace, IMAGE_EXTENSIONS);
      }

      default:
        throw new EngineError(
          EngineFailureCode.UnsupportedMedia,
          `Unsupported download type: ${String(request.type)}`,
        );
    }
  }

  #buildVideoSelector(request: EngineDownloadRequest): string {
    const policy = this.options.registry.get(request.platform).createPolicy();
    const requestedHeight = parseRequestedHeight(request.quality);
    return this.#selector.buildVideoSelector({
      requestedHeight,
      maxBytes: this.options.limits.maxDownloadBytes,
      // Honouring a specific height with the unlabelled pre-muxed file would be
      // a lie, since that file has no height metadata to check against.
      allowProgressiveShortcut: policy.preferProgressive && requestedHeight === undefined,
      formatId: request.formatId,
    });
  }

  /**
   * Pick the produced file, preferring what yt-dlp reported and falling back to
   * a scan of the workspace. Every candidate is checked to be inside the
   * workspace before it is used.
   */
  async #firstProducedFile(
    reported: readonly string[],
    workspace: JobWorkspace,
    allowedExtensions: ReadonlySet<string> | undefined,
  ): Promise<string> {
    const onDisk = await workspace.listFiles();
    const candidates = [...reported, ...onDisk].filter((path) => path !== '');

    const matching = candidates.filter((path) => {
      if (path.endsWith('.part') || path.endsWith('.ytdl')) return false;
      if (allowedExtensions === undefined) return true;
      return allowedExtensions.has(extname(path).toLowerCase());
    });

    // Largest wins: an audio extraction leaves the source video behind, and a
    // video merge leaves its two inputs — the product is the biggest of them
    // only for audio, so filter by extension first and size second.
    let best: { path: string; size: number } | undefined;
    for (const candidate of matching) {
      try {
        const safePath = await assertContainedPath(candidate, workspace.directory);
        const { size } = await stat(safePath);
        if (best === undefined || size > best.size) best = { path: safePath, size };
      } catch {
        // Reported but absent, or outside the workspace. Either way, not ours.
      }
    }

    if (best === undefined) {
      throw new EngineError(
        EngineFailureCode.FormatUnavailable,
        'yt-dlp finished without producing a usable file',
      );
    }
    return best.path;
  }

  async #finalise(
    request: EngineDownloadRequest,
    workspace: JobWorkspace,
    producedPath: string,
    signal: AbortSignal,
    context: EngineDownloadContext,
  ): Promise<EngineDownloadedMedia> {
    let finalPath = producedPath;
    let video: EngineVideoMetadata | undefined;
    // Audio and images never reach the playback normalizer, so they keep the
    // plan a missing probe produces: nothing to do, send it as it is. The
    // sender switches on the download type before it looks at this, so an audio
    // file is never at risk of being treated as a video because of it.
    let plan: NormalizationPlan = planNormalization(undefined, 0, {
      maxTranscodeBytes: this.options.limits.maxDownloadBytes,
      fastDelivery: false,
    });

    if (request.type === DownloadType.Video) {
      // Normalise BEFORE probing and thumbnailing, so the metadata describes the
      // file the user actually receives rather than an intermediate.
      const normalized = await this.options.normalizer.normalize(finalPath, {
        signal,
        ...(context.onStageChange === undefined ? {} : { onStageChange: context.onStageChange }),
      });
      finalPath = normalized.filePath;
      plan = normalized.plan;
      const probe = normalized.probe;
      const thumbnailPath = await this.options.thumbnails.generate(
        finalPath,
        probe?.durationSeconds,
        signal,
      );
      video = {
        // A 90 or 270 degree rotation means the stored dimensions are
        // transposed; sending them unswapped makes Telegram letterbox the video
        // into the wrong box.
        width: swapForRotation(probe?.rotationDegrees) ? probe?.height : probe?.width,
        height: swapForRotation(probe?.rotationDegrees) ? probe?.width : probe?.height,
        durationSeconds: probe?.durationSeconds,
        thumbnailPath,
        videoCodec: probe?.videoCodec,
        audioCodec: probe?.audioCodec,
        container: probe?.formatName,
      };
    } else if (request.type === DownloadType.Image) {
      finalPath = (await this.options.imageNormalizer.normalize(finalPath, signal)).filePath;
    }

    const { size } = await stat(finalPath);
    // The third tier, and the only one that weighs the file the user actually
    // gets. The watchdog stopped looking when the download did, and ffmpeg can
    // hand back something larger than it was given: a re-encode of an already
    // efficiently-compressed source grows, and even a stream copy pays
    // container overhead. Failing here is worth more than it costs — the
    // alternative is handing an undeliverable file onward and discovering the
    // ceiling from Telegram, after the upload.
    const maxBytes = this.options.limits.maxDownloadBytes;
    if (size > maxBytes) {
      throw new EngineError(
        EngineFailureCode.MediaTooLarge,
        `Produced file is ${formatBytes(size)}, over the ${formatBytes(maxBytes)} ceiling`,
        { context: { fileSize: size, maxBytes } },
      );
    }

    return {
      filePath: finalPath,
      fileName: buildFileName(finalPath),
      mimeType: mimeTypeForPath(finalPath),
      fileSize: size,
      video,
      deliveryMode: plan.mode,
      transcodeSkippedReason: plan.transcodeSkippedReason,
      cleanup: () => workspace.cleanup(),
    };
  }

  #toEngineError(error: unknown, fallback: EngineFailureCode): EngineError {
    if (error instanceof YtDlpProcessError) {
      return this.#errors.map({
        exitCode: error.exitCode,
        signal: error.signal,
        stderr: error.stderr,
        cause: error.cause,
      });
    }
    return this.#errors.mapUnknown(error, fallback);
  }
}

function swapForRotation(rotationDegrees: number | undefined): boolean {
  return rotationDegrees === 90 || rotationDegrees === 270;
}

/**
 * The name Telegram shows. Derived from the on-disk name, which came from the
 * extractor id rather than the title, and sanitised again on the way out —
 * defence in depth costs nothing here.
 */
function buildFileName(filePath: string): string {
  return sanitizeFilename(basename(filePath), { maxBytes: 120, fallback: 'media' }).name;
}

function parseJsonDocument(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new EngineError(EngineFailureCode.MediaNotFound, 'yt-dlp returned no metadata');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // yt-dlp prints one JSON document per line for a playlist even under
    // --dump-single-json in some versions; the first line is the one we want.
    const firstLine = trimmed.split(/\r?\n/)[0] ?? '';
    try {
      return JSON.parse(firstLine);
    } catch {
      throw new EngineError(
        EngineFailureCode.UnsupportedMedia,
        'yt-dlp metadata was not valid JSON',
      );
    }
  }
}
