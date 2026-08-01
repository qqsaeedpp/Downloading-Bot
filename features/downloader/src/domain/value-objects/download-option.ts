import type { DownloadType } from '@tgtools/shared';

/**
 * One button on the quality keyboard.
 *
 * `id` is short and opaque because it travels inside `callback_data`; the
 * height and bitrate are kept alongside it so the worker can rebuild the
 * request without a second lookup.
 */
export interface DownloadOption {
  readonly id: string;
  readonly type: DownloadType;
  readonly label: string;
  readonly height: number | undefined;
  readonly audioBitrateKbps: number | undefined;
  /** Best available guess. Advisory — the runtime watchdog is the real limit. */
  readonly estimatedBytes: number | undefined;
  readonly formatId: string | undefined;
}

/**
 * The quality string stored on the job and handed back to the engine.
 * `"1080p"` for video, `"192k"` for audio, and nothing at all for an image.
 */
export function toQualityString(option: DownloadOption): string | undefined {
  if (option.height !== undefined) return `${option.height}p`;
  if (option.audioBitrateKbps !== undefined) return `${option.audioBitrateKbps}k`;
  return undefined;
}

export function findOption(
  options: readonly DownloadOption[],
  id: string,
): DownloadOption | undefined {
  return options.find((option) => option.id === id);
}
