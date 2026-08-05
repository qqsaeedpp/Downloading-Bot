/**
 * The names the file-processing tools are known by, in one place.
 *
 * Separate from `vocabulary.ts` on purpose: that file is the DOWNLOADER's
 * shared kernel, and the tools are a different feature with a different
 * lifecycle. Mixing them would mean every downloader change re-touches a file
 * the tools depend on, and vice versa.
 *
 * The keys are dotted (`image.compress`) rather than flat because the prefix is
 * load-bearing — it selects the queue, the worker concurrency and the resource
 * ceilings, so it has to be recoverable from the key alone.
 */

export const TOOL_FAMILY_VALUES = ['image', 'video', 'pdf', 'qr'] as const;

export const ToolFamily = {
  Image: 'image',
  Video: 'video',
  Pdf: 'pdf',
  Qr: 'qr',
} as const;
export type ToolFamily = (typeof ToolFamily)[keyof typeof ToolFamily];

export const ALL_TOOL_FAMILIES: readonly ToolFamily[] = TOOL_FAMILY_VALUES;

/**
 * Every operation the tools worker can perform.
 *
 * Deliberately stored as TEXT in the database rather than a PostgreSQL enum:
 * adding a tool would otherwise need a migration that rewrites a type, and the
 * project has already been bitten once by an enum value that existed in code
 * and not in the database. The application vocabulary plus a Zod check at the
 * boundary gives the same safety without the DDL.
 */
export const TOOL_KEY_VALUES = [
  'image.compress',
  'image.resize',
  'image.convert',
  'video.extract_mp3',
  'video.remove_audio',
  'pdf.images_to_pdf',
  'pdf.to_images',
  'qr.generate',
] as const;

export const ToolKey = {
  ImageCompress: 'image.compress',
  ImageResize: 'image.resize',
  ImageConvert: 'image.convert',
  VideoExtractMp3: 'video.extract_mp3',
  VideoRemoveAudio: 'video.remove_audio',
  ImagesToPdf: 'pdf.images_to_pdf',
  PdfToImages: 'pdf.to_images',
  QrGenerate: 'qr.generate',
} as const;
export type ToolKey = (typeof ToolKey)[keyof typeof ToolKey];

export const ALL_TOOL_KEYS: readonly ToolKey[] = TOOL_KEY_VALUES;

export function isToolKey(value: string): value is ToolKey {
  return (ALL_TOOL_KEYS as readonly string[]).includes(value);
}

/**
 * Which family — and therefore which queue and which ceilings — a tool belongs
 * to, derived from the key rather than kept in a second table that could
 * disagree with it.
 *
 * `pdf.images_to_pdf` is the case that makes this worth stating: it CONSUMES
 * images but is priced and queued as PDF work, because building the document is
 * where the time and memory go.
 */
export function toolFamilyOf(key: ToolKey): ToolFamily {
  const prefix = key.slice(0, key.indexOf('.'));
  // The cast is safe by construction: every key above begins with a family
  // name, and the test suite asserts that for all of them.
  return prefix as ToolFamily;
}

/**
 * The lifecycle of one tool job.
 *
 * `receiving` is separate from `processing` because fetching a 500 MB video
 * from Telegram is a distinct, slow phase that fails for entirely different
 * reasons than the conversion does — and a user watching a stuck job deserves
 * to know which half it is stuck in.
 */
export const TOOL_JOB_STATUS_VALUES = [
  'pending',
  'queued',
  'receiving',
  'processing',
  'uploading',
  'completed',
  'failed',
  'cancelled',
  'expired',
] as const;

export const ToolJobStatus = {
  Pending: 'pending',
  Queued: 'queued',
  Receiving: 'receiving',
  Processing: 'processing',
  Uploading: 'uploading',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Expired: 'expired',
} as const;
export type ToolJobStatus = (typeof ToolJobStatus)[keyof typeof ToolJobStatus];

/** Statuses from which no further transition is legal. */
export const TERMINAL_TOOL_JOB_STATUSES: readonly ToolJobStatus[] = [
  ToolJobStatus.Completed,
  ToolJobStatus.Failed,
  ToolJobStatus.Cancelled,
  ToolJobStatus.Expired,
];

export function isTerminalToolJobStatus(status: ToolJobStatus): boolean {
  return TERMINAL_TOOL_JOB_STATUSES.includes(status);
}
