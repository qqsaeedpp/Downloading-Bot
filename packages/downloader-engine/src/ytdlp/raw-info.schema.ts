import { z } from 'zod';

/**
 * A tolerant view of `yt-dlp --dump-single-json`.
 *
 * Every extractor returns a different subset, and the set changes between
 * releases, so a strict schema would fail on perfectly good media. The rule
 * here is: validate the *shape* we intend to read and quietly drop anything
 * that does not fit, rather than reject the document. Nothing downstream is
 * allowed to assume a field is present.
 */

const looseNumber = z.preprocess(
  (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined),
  z.number().optional(),
);

const looseString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined),
  z.string().optional(),
);

const looseArray = z.preprocess(
  (value): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []),
  z.array(z.unknown()),
);

export const rawFormatSchema = z.object({
  format_id: z.preprocess(
    (value) => (typeof value === 'number' ? String(value) : value),
    z.string(),
  ),
  ext: looseString,
  width: looseNumber,
  height: looseNumber,
  fps: looseNumber,
  vcodec: looseString,
  acodec: looseString,
  filesize: looseNumber,
  /** yt-dlp's own estimate; the type definitions of most wrappers omit it. */
  filesize_approx: looseNumber,
  tbr: looseNumber,
  abr: looseNumber,
  vbr: looseNumber,
  protocol: looseString,
  format_note: looseString,
  resolution: looseString,
});

export type RawFormat = z.infer<typeof rawFormatSchema>;

export const rawThumbnailSchema = z.object({
  url: z.string(),
  width: looseNumber,
  height: looseNumber,
  preference: looseNumber,
});

export type RawThumbnail = z.infer<typeof rawThumbnailSchema>;

export const rawInfoSchema = z.object({
  _type: looseString,
  id: looseString,
  title: looseString,
  ext: looseString,
  description: looseString,
  uploader: looseString,
  uploader_id: looseString,
  channel: looseString,
  creator: looseString,
  duration: looseNumber,
  thumbnail: looseString,
  /** yt-dlp's `YYYYMMDD`. */
  upload_date: looseString,
  view_count: looseNumber,
  like_count: looseNumber,
  comment_count: looseNumber,
  repost_count: looseNumber,
  webpage_url: looseString,
  extractor: looseString,
  extractor_key: looseString,
  formats: looseArray,
  thumbnails: looseArray,
  /** Present when the URL turned out to name a carousel or a playlist. */
  entries: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.unknown()).optional(),
  ),
});

export type RawInfo = z.infer<typeof rawInfoSchema>;

/**
 * Parse elements one at a time and drop the ones that do not fit, so a single
 * malformed entry cannot cost us the other twenty.
 */
export function parseArrayLeniently<TOut>(
  values: readonly unknown[],
  schema: z.ZodType<TOut>,
): { items: TOut[]; skipped: number } {
  const items: TOut[] = [];
  let skipped = 0;
  for (const value of values) {
    const result = schema.safeParse(value);
    if (result.success) items.push(result.data);
    else skipped += 1;
  }
  return { items, skipped };
}
