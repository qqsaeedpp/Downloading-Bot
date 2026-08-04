import { DownloadType, MediaKind, bytesToMegabytes } from '@tgtools/shared';
import type { EngineMediaFormat, EngineQualityOption } from '../engine-types.js';

/**
 * Whether an audio track can actually be produced from this post.
 *
 * Written as an explicit evidence ladder rather than a guess, because the old
 * code guessed: `listAudioOptions` had a floor that returned a 128 kbps option
 * whenever it had nothing better to say, so an image-only tweet — which has no
 * formats at all — advertised two audio bitrates that could never be delivered.
 */
export function hasExtractableAudio(
  formats: readonly EngineMediaFormat[],
  mediaKind: MediaKind,
): boolean {
  // 0. Nothing to extract FROM. A blocked YouTube extraction returns metadata,
  //    a duration and no formats at all; the kind is legitimately "video", but
  //    there is no rendition to pull a soundtrack out of.
  if (formats.length === 0) return false;

  // 1. Positive evidence: something declares a real audio codec.
  if (formats.some((format) => format.audioCodec !== undefined && format.audioCodec !== 'none'))
    return true;

  // 2. Negative evidence: a format says, in so many words, that it has none.
  //    A tweeted GIF is a silent MP4 and yt-dlp reports `acodec: "none"`.
  if (formats.some((format) => format.audioCodec === 'none')) return false;

  // 3. No format describes its audio at all. Instagram's pre-muxed file is like
  //    this — it really is a video with sound, yt-dlp simply cannot read it —
  //    so infer from the kind rather than refusing. An image or an unclassified
  //    post gets nothing.
  return mediaKind === MediaKind.Video || mediaKind === MediaKind.Audio;
}

export interface VideoSelectorInput {
  /** Height the user picked, e.g. 1080. Absent means "best available". */
  readonly requestedHeight: number | undefined;
  readonly maxBytes: number;
  /**
   * Whether the platform's unlabelled pre-muxed file may be tried first. Only
   * ever true when the request is for the best available quality — see
   * {@link PlatformDownloadPolicy.preferProgressive}.
   */
  readonly allowProgressiveShortcut: boolean;
  /** Exact format the caller wants. Still followed by the fallback chain. */
  readonly formatId: string | undefined;
}

export interface AudioSelectorInput {
  readonly targetBitrateKbps: number | undefined;
  readonly maxBytes: number;
}

/** Bitrates worth offering, smallest first. */
const AUDIO_BITRATE_LADDER: readonly number[] = [128, 192, 320];

/** More than this many buttons and the keyboard stops being a keyboard. */
const MAX_VIDEO_OPTIONS = 6;

/**
 * Every candidate worth trying at ONE resolution, best-playing first.
 *
 * Telegram's inline player wants H.264 video with AAC audio; hand it VP9, Opus
 * or AV1 and the clip arrives as a file attachment instead, unless we spend
 * minutes of CPU re-encoding a stream the source frequently published in the
 * right codec to begin with. So both halves of the container are asked for
 * explicitly before either is given up — it costs nothing when the pair exists,
 * and falls through to the codec-agnostic rungs when it does not.
 *
 * Kept as one ladder per height filter rather than one pass per codec, because
 * that is what makes the resolution dominant: the caller runs it against the
 * exact height first and every rung here — the unconstrained ones included — is
 * exhausted before a single candidate one resolution down is considered.
 */
function codecLadder(heightFilter: string, sizeFilter: string): readonly string[] {
  const at = `${heightFilter}${sizeFilter}`;
  return [
    // Both halves already correct, merged by yt-dlp. Nothing to re-encode.
    `bv*${at}[vcodec^=avc1]+ba[acodec^=mp4a]`,
    // The same pair, pre-muxed by the source. Cheaper still, since there is no
    // merge step at all, and it is what the MP4-era platforms actually serve.
    `b${at}[vcodec^=avc1][acodec^=mp4a]`,
    // Video is the expensive half to fix, so take an H.264 track even when the
    // only audio on offer is Opus: transcoding a soundtrack costs seconds.
    `bv*${at}[vcodec^=avc1]+ba`,
    `b${at}[vcodec^=avc1]`,
    // Codec preference exhausted at this height. Accepting VP9/AV1 here and
    // paying for the re-encode is honest; quietly dropping a resolution to
    // avoid it would not be, which is why these rungs stay above the next
    // ladder rather than below it.
    `bv*${at}+ba`,
    `b${at}`,
  ];
}

/**
 * Builds yt-dlp `-f` expressions and derives the quality menu.
 *
 * This is the most consequential piece of logic in the engine: get it wrong and
 * a user asking for 1080p silently receives 480p, or a "download" turns into an
 * unbounded pull. It is deliberately pure — no filesystem, no process, no
 * clock — so every rule below is covered by a unit test.
 */
export class YtDlpFormatSelector {
  /**
   * A `/`-separated fallback chain, so a missing exact format degrades instead
   * of hard-failing with "Requested format is not available".
   *
   * Ordering rule, learned the hard way: the RESOLUTION the user tapped comes
   * first and H.264 is only the tiebreak *within* it. Putting the codec first
   * silently downgrades a 2160p request to 1080p, because the best AVC1
   * rendition is often 1080p and `height<=2160` matches it happily. Where the
   * exact height has no AVC1 copy — 4K is usually VP9/AV1, as is every
   * Instagram reel — the normaliser re-encodes afterwards, so the pick stays
   * both honest and playable.
   *
   * Within a height the audio codec is the second tiebreak: see
   * {@link codecLadder} for why AAC is asked for alongside H.264.
   */
  buildVideoSelector(input: VideoSelectorInput): string {
    const maxMb = Math.max(1, Math.floor(bytesToMegabytes(input.maxBytes)));

    // STRICT matches only formats that actually declare a size, so a
    // known-huge stream can never win. Unknown-size formats are excluded here
    // on purpose: letting them through is how a "1080p" pick becomes an
    // unbounded download.
    const strict = `[filesize<${maxMb}M]`;
    // LENIENT admits unknown sizes, and is used only as the last resort —
    // Instagram and TikTok never report a size, so refusing outright would mean
    // refusing them entirely. The runtime watchdog is the backstop.
    const lenient = `[filesize<?${maxMb}M]`;

    const height = input.requestedHeight;
    const exact = height === undefined ? '' : `[height=${height}]`;
    const atMost = height === undefined ? '' : `[height<=${height}]`;

    const chain: string[] = [];

    if (input.formatId !== undefined && input.formatId !== '') {
      chain.push(input.formatId);
    }

    // The pre-muxed file carries no height metadata at all, so any height
    // filter excludes it. That is why this candidate is unconstrained, and why
    // it is only allowed when the user asked for the best quality anyway.
    if (input.allowProgressiveShortcut) {
      chain.push(`b${lenient}[vcodec^=avc1]`, `b${lenient}`);
    }

    // What the user actually tapped, tried to exhaustion before anything below
    // it is looked at.
    if (height !== undefined) {
      chain.push(...codecLadder(exact, strict));
    }

    // The nearest lower resolution, same preferences. Reached only once the
    // requested height has nothing at all to offer under the size ceiling.
    chain.push(...codecLadder(atMost, strict));

    chain.push(
      `bv*${atMost}${lenient}+ba`,
      `b${atMost}${lenient}`,
      `bv*${lenient}+ba`,
      `b${lenient}`,
    );

    return chain.join('/');
  }

  /**
   * Audio is extracted by a post-processor, so the selector only has to land on
   * the best audio stream; `--audio-quality` decides the output bitrate.
   */
  buildAudioSelector(input: AudioSelectorInput): string {
    const maxMb = Math.max(1, Math.floor(bytesToMegabytes(input.maxBytes)));
    const lenient = `[filesize<?${maxMb}M]`;
    return [`ba${lenient}`, 'ba', `b${lenient}`, 'b'].join('/');
  }

  /**
   * The video qualities worth putting on a keyboard: real heights the source
   * actually offers, minus any whose declared size already exceeds the ceiling.
   */
  listVideoOptions(
    formats: readonly EngineMediaFormat[],
    maxBytes: number,
    durationSeconds: number | undefined,
  ): readonly EngineQualityOption[] {
    const bestByHeight = new Map<number, { bytes: number | undefined; hasKnownSize: boolean }>();

    for (const format of formats) {
      if (format.isAudioOnly) continue;
      const height = format.height;
      if (height === undefined || height <= 0) continue;

      const bytes = this.estimateBytes(format, durationSeconds);
      const hasKnownSize = format.filesizeBytes !== undefined;
      const existing = bestByHeight.get(height);
      if (existing === undefined) {
        bestByHeight.set(height, { bytes, hasKnownSize });
        continue;
      }
      // Prefer the smallest deliverable candidate at a given height: it is the
      // one most likely to fit under the upload ceiling.
      if (existing.bytes === undefined || (bytes !== undefined && bytes < existing.bytes)) {
        bestByHeight.set(height, { bytes, hasKnownSize: hasKnownSize || existing.hasKnownSize });
      }
    }

    return [...bestByHeight.entries()]
      .filter(([, estimate]) => {
        // Only a *declared* size may disqualify a quality. Excluding unknowns
        // would leave Instagram and TikTok with an empty menu.
        if (!estimate.hasKnownSize || estimate.bytes === undefined) return true;
        return estimate.bytes <= maxBytes;
      })
      .sort(([left], [right]) => right - left)
      .slice(0, MAX_VIDEO_OPTIONS)
      .map(([height, estimate]) => ({
        id: `v${height}`,
        type: DownloadType.Video,
        label: `${height}p`,
        height,
        audioBitrateKbps: undefined,
        estimatedBytes: estimate.bytes,
        formatId: undefined,
      }));
  }

  /**
   * Audio options capped by what the source can actually deliver.
   *
   * Two separate lies are avoided here. Offering "320 kbps" for a reel whose
   * audio track is 64 kbps produces a file five times larger that sounds
   * identical. And offering ANY bitrate for a post with no audio at all — a
   * photo tweet, a silent GIF — queues a job the extractor can only answer with
   * "No video could be found in this tweet", after the user has already waited.
   */
  listAudioOptions(
    formats: readonly EngineMediaFormat[],
    durationSeconds: number | undefined,
    mediaKind: MediaKind,
  ): readonly EngineQualityOption[] {
    if (!hasExtractableAudio(formats, mediaKind)) return [];

    const sourceBitrate = formats.reduce<number | undefined>((best, format) => {
      const bitrate = format.audioBitrateKbps;
      if (bitrate === undefined || bitrate <= 0) return best;
      return best === undefined || bitrate > best ? bitrate : best;
    }, undefined);

    const offered =
      sourceBitrate === undefined
        ? // Nothing declared. 320 would be an unfounded claim, so stop at 192.
          AUDIO_BITRATE_LADDER.filter((bitrate) => bitrate <= 192)
        : AUDIO_BITRATE_LADDER.filter((bitrate) => bitrate <= Math.ceil(sourceBitrate));

    // A source quieter than the lowest rung still gets that rung: we have
    // already established there IS audio, so refusing to offer any would be as
    // wrong as inventing one. This floor is only reachable with real audio.
    const ladder = offered.length > 0 ? offered : [AUDIO_BITRATE_LADDER[0] ?? 128];

    return ladder
      .slice()
      .reverse()
      .map((bitrate) => ({
        id: `a${bitrate}`,
        type: DownloadType.Audio,
        label: `${bitrate} kbps`,
        height: undefined,
        audioBitrateKbps: bitrate,
        estimatedBytes:
          durationSeconds === undefined
            ? undefined
            : Math.round((bitrate * 1000 * durationSeconds) / 8),
        formatId: undefined,
      }));
  }

  /**
   * Declared size when there is one, otherwise bitrate times duration. Both are
   * approximations; the caller must treat the result as advisory, which is why
   * the runtime watchdog exists.
   *
   * There is no separate `filesize_approx` rung because there is no separate
   * field: the mapper folds `filesize` and `filesize_approx` into
   * `filesizeBytes`, an approximate size being evidence all the same.
   */
  estimateBytes(
    format: EngineMediaFormat,
    durationSeconds: number | undefined,
  ): number | undefined {
    if (format.filesizeBytes !== undefined && format.filesizeBytes > 0) return format.filesizeBytes;
    if (
      format.totalBitrateKbps !== undefined &&
      format.totalBitrateKbps > 0 &&
      durationSeconds !== undefined &&
      durationSeconds > 0
    ) {
      return Math.round((format.totalBitrateKbps * 1000 * durationSeconds) / 8);
    }
    return undefined;
  }

  /**
   * The smallest video rendition the download chain could possibly land on.
   *
   * A floor rather than a prediction, and deliberately so. The chain built by
   * {@link buildVideoSelector} ends in two rungs carrying no height filter at
   * all, so every video-bearing format really is reachable — which means the
   * only refusal that can never be wrong is "not one rendition of this post
   * fits". Estimating the rendition yt-dlp is *likely* to choose would reject
   * requests it would have served from a smaller copy.
   *
   * A pinned `formatId` is not special-cased for the same reason: the chain
   * keeps its fallbacks behind an exact id, so the floor is unchanged.
   *
   * Audio is not added to a video-only candidate either. At ~128 kbps against a
   * multi-megabit video track it is noise, and every rounding error here should
   * fall on the side of letting the download run.
   */
  estimateSmallestVideoBytes(
    formats: readonly EngineMediaFormat[],
    durationSeconds: number | undefined,
  ): number | undefined {
    return formats.reduce<number | undefined>((smallest, format) => {
      if (format.isAudioOnly) return smallest;
      const bytes = this.estimateBytes(format, durationSeconds);
      if (bytes === undefined) return smallest;
      return smallest === undefined || bytes < smallest ? bytes : smallest;
    }, undefined);
  }

  /** Highest height the source labels, used to decide the progressive shortcut. */
  maxLabelledHeight(formats: readonly EngineMediaFormat[]): number | undefined {
    return formats.reduce<number | undefined>((best, format) => {
      if (format.isAudioOnly || format.height === undefined) return best;
      return best === undefined || format.height > best ? format.height : best;
    }, undefined);
  }
}

/** `"1080p"`, `"1080"`, `"hd1080"` → `1080`. Anything else → undefined. */
export function parseRequestedHeight(quality: string | undefined): number | undefined {
  if (quality === undefined) return undefined;
  const match = /(\d{3,4})/.exec(quality);
  if (match?.[1] === undefined) return undefined;
  const height = Number(match[1]);
  return Number.isFinite(height) && height > 0 ? height : undefined;
}

/** `"192k"`, `"192kbps"`, `"a192"` → `192`. */
export function parseRequestedBitrate(quality: string | undefined): number | undefined {
  if (quality === undefined) return undefined;
  const match = /(\d{2,3})\s*k?/i.exec(quality);
  if (match?.[1] === undefined) return undefined;
  const bitrate = Number(match[1]);
  return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined;
}
