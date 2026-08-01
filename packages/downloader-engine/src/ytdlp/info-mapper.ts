import { MediaKind } from '@tgtools/shared';
import type { Logger, MediaPlatform } from '@tgtools/shared';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import type { EngineMediaFormat, EngineMediaInfo } from '../engine-types.js';
import type { RawFormat, RawInfo, RawThumbnail } from './raw-info.schema.js';
import {
  parseArrayLeniently,
  rawFormatSchema,
  rawInfoSchema,
  rawThumbnailSchema,
} from './raw-info.schema.js';

export interface MapInfoContext {
  readonly sourceUrl: string;
  readonly platform: MediaPlatform;
  readonly obtainedWithCookies: boolean;
}

/**
 * The boundary between "whatever yt-dlp printed" and the engine's own model.
 *
 * Nothing above this class ever sees a raw field name, so a yt-dlp release that
 * renames one breaks here — loudly, in a tested unit — instead of leaking a
 * silent `undefined` into a Telegram card.
 */
export class YtDlpInfoMapper {
  constructor(private readonly logger: Logger) {}

  map(document: unknown, context: MapInfoContext): EngineMediaInfo {
    const parsed = rawInfoSchema.safeParse(document);
    if (!parsed.success) {
      throw new EngineError(
        EngineFailureCode.UnsupportedMedia,
        'yt-dlp returned a document that could not be interpreted',
        { context: { issues: parsed.error.issues.length } },
      );
    }

    const info = this.#unwrapPlaylist(parsed.data);
    const { items: rawFormats, skipped } = parseArrayLeniently(info.formats, rawFormatSchema);
    if (skipped > 0) {
      this.logger.debug('dropped unparsable formats', { skipped, platform: context.platform });
    }

    const formats = rawFormats.map(toEngineFormat);
    const { items: thumbnails } = parseArrayLeniently(info.thumbnails, rawThumbnailSchema);

    return {
      sourceUrl: context.sourceUrl,
      platform: context.platform,
      extractorId: info.id,
      // A missing title is common on Pinterest and X. Falling back to the
      // extractor id keeps the card readable without inventing a name.
      title: info.title ?? info.id ?? 'media',
      uploader: info.uploader ?? info.channel ?? info.creator,
      durationSeconds: info.duration !== undefined && info.duration > 0 ? info.duration : undefined,
      thumbnailUrl: info.thumbnail ?? bestThumbnailUrl(thumbnails),
      uploadDate: toIsoDate(info.upload_date),
      description: info.description,
      statistics: {
        viewCount: info.view_count,
        likeCount: info.like_count,
        commentCount: info.comment_count,
      },
      mediaKind: classifyMediaKind(formats, info),
      obtainedWithCookies: context.obtainedWithCookies,
      formats,
    };
  }

  /**
   * A carousel or a profile link comes back as a playlist. The first entry is
   * the post the user meant; deeper support would need a UI for choosing
   * between items, which the first phase does not have.
   */
  #unwrapPlaylist(info: RawInfo): RawInfo {
    if (info._type !== 'playlist' || info.entries === undefined) return info;
    const first = info.entries[0];
    if (first === undefined) {
      throw new EngineError(EngineFailureCode.MediaNotFound, 'Playlist contained no entries');
    }
    const parsed = rawInfoSchema.safeParse(first);
    if (!parsed.success) {
      throw new EngineError(
        EngineFailureCode.UnsupportedMedia,
        'First playlist entry could not be interpreted',
      );
    }
    this.logger.debug('unwrapped playlist to its first entry', {
      entries: info.entries.length,
    });
    // Keep the container's title when the entry has none — a carousel's items
    // are frequently untitled.
    return { ...parsed.data, title: parsed.data.title ?? info.title };
  }
}

function toEngineFormat(raw: RawFormat): EngineMediaFormat {
  const hasVideo = raw.vcodec !== undefined && raw.vcodec !== 'none';
  const hasAudio = raw.acodec !== undefined && raw.acodec !== 'none';
  return {
    id: raw.format_id,
    ext: raw.ext ?? 'mp4',
    width: raw.width,
    height: raw.height,
    fps: raw.fps,
    videoCodec: raw.vcodec,
    audioCodec: raw.acodec,
    filesizeBytes: raw.filesize ?? raw.filesize_approx,
    totalBitrateKbps: raw.tbr,
    audioBitrateKbps: raw.abr,
    protocol: raw.protocol,
    formatNote: raw.format_note,
    isProgressive: hasVideo && hasAudio,
    isVideoOnly: hasVideo && !hasAudio,
    // A format with neither codec declared is treated as audio-only only when
    // it says so; Instagram's pre-muxed file declares nothing and must not be
    // mistaken for an audio stream.
    isAudioOnly: !hasVideo && hasAudio,
  };
}

/**
 * Decide what the post actually is.
 *
 * An image-only post (a Pinterest pin, an Instagram photo) is the case that
 * matters: it has no formats worth showing, and offering a quality menu for it
 * produces an empty keyboard.
 */
export function classifyMediaKind(
  formats: readonly EngineMediaFormat[],
  info: Pick<RawInfo, 'thumbnail' | 'ext' | 'duration'>,
): MediaKind {
  const hasVideo = formats.some((format) => format.isProgressive || format.isVideoOnly);
  if (hasVideo) return MediaKind.Video;

  const hasAudio = formats.some((format) => format.isAudioOnly);
  if (hasAudio) return MediaKind.Audio;

  const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
  const looksLikeImage =
    info.thumbnail !== undefined ||
    (info.ext !== undefined && imageExtensions.has(info.ext.toLowerCase())) ||
    formats.some((format) => imageExtensions.has(format.ext.toLowerCase()));

  return looksLikeImage ? MediaKind.Image : MediaKind.Unknown;
}

/** Largest thumbnail wins; `preference` breaks ties when dimensions are absent. */
function bestThumbnailUrl(thumbnails: readonly RawThumbnail[]): string | undefined {
  let best: RawThumbnail | undefined;
  for (const candidate of thumbnails) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    const candidateArea = (candidate.width ?? 0) * (candidate.height ?? 0);
    const bestArea = (best.width ?? 0) * (best.height ?? 0);
    if (candidateArea > bestArea) best = candidate;
    else if (candidateArea === bestArea && (candidate.preference ?? -1) > (best.preference ?? -1)) {
      best = candidate;
    }
  }
  return best?.url;
}

/** `20260131` → `2026-01-31`. Anything else is dropped rather than guessed at. */
export function toIsoDate(compact: string | undefined): string | undefined {
  if (compact === undefined) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(compact.trim());
  if (match === null) return undefined;
  const [, year, month, day] = match;
  return `${year ?? ''}-${month ?? ''}-${day ?? ''}`;
}
