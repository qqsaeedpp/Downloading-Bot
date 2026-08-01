const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Human-readable size. Locale-neutral; digit shaping belongs to presentation. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? 'B';
  return `${value.toFixed(fractionDigits)} ${unit}`;
}

export function megabytesToBytes(megabytes: number): number {
  return Math.floor(megabytes * 1024 * 1024);
}

export function bytesToMegabytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

/** `93` → `1:33`, `3725` → `1:02:05`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}

/** Fixed-width bar for a progress message; `undefined` progress renders empty. */
export function renderProgressBar(percent: number | undefined, width = 10): string {
  if (percent === undefined || !Number.isFinite(percent)) return '░'.repeat(width);
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
