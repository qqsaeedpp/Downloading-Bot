import { ALL_DOWNLOAD_TYPES, ALL_MEDIA_PLATFORMS } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { jobStatusEnum, mediaTypeEnum, platformEnum } from './enums.js';

/**
 * A drift guard, not a behaviour test. The Postgres enums and the shared domain
 * vocabulary are declared in two different packages; adding a platform to one
 * and forgetting the other produces rows the application cannot write. That
 * mistake should fail here rather than in production.
 */

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

/** The statuses a download job may hold, in the order they occur. */
const DOCUMENTED_JOB_STATUSES = [
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
] as const;

describe('media_platform enum', () => {
  it('holds exactly the platforms the shared vocabulary defines', () => {
    expect(sorted(platformEnum.enumValues)).toEqual(sorted(ALL_MEDIA_PLATFORMS));
  });

  it('has no duplicate members', () => {
    expect(new Set(platformEnum.enumValues).size).toBe(platformEnum.enumValues.length);
  });

  it('is named after the database type it creates', () => {
    expect(platformEnum.enumName).toBe('media_platform');
  });
});

describe('download_media_type enum', () => {
  it('holds exactly the download types the shared vocabulary defines', () => {
    expect(sorted(mediaTypeEnum.enumValues)).toEqual(sorted(ALL_DOWNLOAD_TYPES));
  });

  it('has no duplicate members', () => {
    expect(new Set(mediaTypeEnum.enumValues).size).toBe(mediaTypeEnum.enumValues.length);
  });

  it('is named after the database type it creates', () => {
    expect(mediaTypeEnum.enumName).toBe('download_media_type');
  });
});

describe('download_job_status enum', () => {
  it('holds exactly the eleven documented statuses', () => {
    expect(jobStatusEnum.enumValues).toHaveLength(11);
    expect(sorted(jobStatusEnum.enumValues)).toEqual(sorted(DOCUMENTED_JOB_STATUSES));
  });

  it('lists the statuses in lifecycle order, terminal states last', () => {
    expect([...jobStatusEnum.enumValues]).toEqual([...DOCUMENTED_JOB_STATUSES]);
  });

  it('has no duplicate members', () => {
    expect(new Set(jobStatusEnum.enumValues).size).toBe(jobStatusEnum.enumValues.length);
  });

  it('is named after the database type it creates', () => {
    expect(jobStatusEnum.enumName).toBe('download_job_status');
  });
});
