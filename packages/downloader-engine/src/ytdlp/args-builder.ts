import { bytesToMegabytes } from '@tgtools/shared';

/**
 * Every yt-dlp argument list is produced here, as an array of separate strings.
 *
 * Never a command line, never a template, never interpolation: the URL and the
 * title are remote input, and the only reliable way to keep them out of the
 * shell is to never build a shell string in the first place. The runner spawns
 * with `shell: false`, so an argument containing a space, a quote or a
 * semicolon is exactly one argument.
 */

export interface BaseArgsInput {
  readonly cookiePath: string | undefined;
  readonly platformExtraArgs: readonly string[];
  readonly socketTimeoutSeconds?: number;
  /** Applies to every request. Usually a residential exit for a flagged VPS. */
  readonly proxyUrl?: string | undefined;
  /**
   * Each entry already carries its own extractor key, e.g.
   * `youtube:player_client=tv` or `youtubepot-bgutilhttp:base_url=http://…`.
   *
   * A list rather than one string because the keys differ: the PO token
   * provider is registered under its own extractor name, so it cannot be folded
   * into the platform's entry. yt-dlp merges repeated `--extractor-args`.
   */
  readonly extractorArgs?: readonly string[] | undefined;
}

/**
 * Shared across inspect and download.
 *
 * `--ignore-config` matters more than it looks: without it, a `yt-dlp.conf`
 * anywhere on the search path can silently change the format selection, the
 * output path or the post-processing of a production download.
 */
export function buildBaseArgs(input: BaseArgsInput): string[] {
  const args = [
    '--ignore-config',
    '--no-color',
    '--no-playlist',
    // Reproducible mtimes; without this a downloaded file inherits the remote
    // timestamp, which confuses the orphan sweep's age check.
    '--no-mtime',
    '--socket-timeout',
    String(input.socketTimeoutSeconds ?? 30),
    '--retries',
    '3',
    '--fragment-retries',
    '3',
  ];

  if (input.cookiePath !== undefined) args.push('--cookies', input.cookiePath);
  if (input.proxyUrl !== undefined) args.push('--proxy', input.proxyUrl);
  for (const entry of input.extractorArgs ?? []) args.push('--extractor-args', entry);
  args.push(...input.platformExtraArgs);
  return args;
}

export interface InspectArgsInput extends BaseArgsInput {
  /**
   * Only for platforms that genuinely publish stills.
   *
   * The flag lets an image-only pin return JSON instead of aborting with "No
   * video formats found". On a video-only platform it does the opposite of what
   * we want: it converts a real extraction failure into a document with
   * metadata and an empty `formats`, which is indistinguishable from a photo
   * post and hides the reason from the user entirely.
   */
  readonly ignoreNoFormatsError: boolean;
}

export function buildInspectArgs(input: InspectArgsInput): string[] {
  return [
    ...buildBaseArgs(input),
    '--dump-single-json',
    '--skip-download',
    ...(input.ignoreNoFormatsError ? ['--ignore-no-formats-error'] : []),
  ];
}

export interface VideoDownloadArgsInput extends BaseArgsInput {
  readonly outputTemplate: string;
  readonly maxBytes: number;
}

export function buildVideoDownloadArgs(input: VideoDownloadArgsInput): string[] {
  return [
    ...buildBaseArgs(input),
    '--output',
    input.outputTemplate,
    // Fires only when the extractor declared an oversized file. The runtime
    // watchdog covers everything that declares nothing.
    '--max-filesize',
    `${Math.max(1, Math.floor(bytesToMegabytes(input.maxBytes)))}M`,
    '--merge-output-format',
    'mp4',
    // Puts the moov atom at the front so a player can start before the file has
    // finished arriving. Only applies when the merger actually runs — a single
    // progressive download skips it, which is why the normaliser remuxes.
    '--postprocessor-args',
    'ffmpeg:-movflags +faststart',
  ];
}

export interface AudioDownloadArgsInput extends BaseArgsInput {
  readonly outputTemplate: string;
  readonly maxBytes: number;
  readonly bitrateKbps: number;
}

export function buildAudioDownloadArgs(input: AudioDownloadArgsInput): string[] {
  return [
    ...buildBaseArgs(input),
    '--output',
    input.outputTemplate,
    '--max-filesize',
    `${Math.max(1, Math.floor(bytesToMegabytes(input.maxBytes)))}M`,
    '--extract-audio',
    '--audio-format',
    'mp3',
    `--audio-quality`,
    `${input.bitrateKbps}K`,
    // Title and artist survive into the file, so Telegram's audio player shows
    // something better than "audio.mp3".
    '--embed-metadata',
  ];
}

export interface ImageDownloadArgsInput extends BaseArgsInput {
  readonly outputTemplate: string;
}

/**
 * Images come out of `--write-thumbnail`: for a video that is the poster frame,
 * and for an image-only pin or photo post it is the content itself. The file is
 * converted to a Telegram-friendly format afterwards, by us, because yt-dlp's
 * `--convert-thumbnails` cannot make the alpha-channel decision.
 */
export function buildImageDownloadArgs(input: ImageDownloadArgsInput): string[] {
  return [
    ...buildBaseArgs(input),
    '--output',
    input.outputTemplate,
    '--write-thumbnail',
    '--skip-download',
    '--ignore-no-formats-error',
  ];
}
