import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enumerations are declared at the database level so an impossible value cannot
 * be written by a future migration script, a manual fix or a second service.
 * The literal arrays are kept in step with the domain vocabulary by
 * `vocabulary.test.ts`, which fails if the two ever drift.
 *
 * Adding a value here requires a migration: Postgres enums are altered, not
 * replaced. See `docs/adding-a-platform.md`.
 */

export const platformEnum = pgEnum('media_platform', [
  'instagram',
  'tiktok',
  'pinterest',
  'x',
  'youtube',
]);

export const mediaTypeEnum = pgEnum('download_media_type', ['video', 'audio', 'image']);

export const jobStatusEnum = pgEnum('download_job_status', [
  'pending',
  'inspecting',
  'awaiting_selection',
  'queued',
  'downloading',
  'processing',
  'uploading',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);
