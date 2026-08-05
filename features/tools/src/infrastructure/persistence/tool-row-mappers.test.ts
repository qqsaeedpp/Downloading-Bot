import type { ToolJobInputRow, ToolJobRow } from '@tgtools/database';
import { ToolJobStatus } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { toToolInputReference, toToolJob } from './tool-row-mappers.js';

function row(overrides: Partial<ToolJobRow> = {}): ToolJobRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    shortId: 'abc12345',
    userId: '22222222-2222-4222-8222-222222222222',
    telegramChatId: 500,
    telegramStatusMessageId: 42,
    toolKey: 'image.compress',
    operationSchemaVersion: 1,
    operationPayload: { tool: 'image.compress', level: 'balanced' },
    status: 'queued',
    progressPercent: 0,
    outputFileId: null,
    outputFileUniqueId: null,
    outputMimeType: null,
    outputFileName: null,
    outputSize: null,
    errorCode: null,
    errorMessageSafe: null,
    attemptCount: 0,
    createdAt: new Date('2026-08-05T10:00:00Z'),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    expiresAt: null,
    updatedAt: new Date('2026-08-05T10:00:00Z'),
    version: 0,
    ...overrides,
  };
}

describe('toToolJob', () => {
  it('turns database nulls into absent fields', () => {
    // The domain says "absent" with `undefined`. Leaking nulls means every
    // reader has to check both, and the one that forgets renders "null" into a
    // Persian sentence.
    const job = toToolJob(row());

    expect(job.errorCode).toBeUndefined();
    expect(job.expiresAt).toBeUndefined();
    expect(job.output).toBeUndefined();
  });

  it('omits the output group entirely when nothing was produced', () => {
    // Not an object of undefineds: callers branch on `job.output === undefined`
    // to decide whether there is a file to talk about, and a truthy object with
    // empty fields makes that check pass for a job that produced nothing.
    expect(toToolJob(row({ status: 'failed' })).output).toBeUndefined();
  });

  it('reads the output group once a file exists', () => {
    const job = toToolJob(
      row({
        status: 'completed',
        outputFileId: 'file-1',
        outputFileUniqueId: 'uniq-1',
        outputMimeType: 'image/jpeg',
        outputFileName: 'photo.jpg',
        outputSize: 1_024,
      }),
    );

    expect(job.output).toEqual({
      fileId: 'file-1',
      fileUniqueId: 'uniq-1',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      sizeBytes: 1_024,
    });
  });

  it('refuses a tool key the running build does not know', () => {
    // `tool_key` is TEXT, not a PostgreSQL enum — deliberately, so adding a
    // ninth tool needs no DDL. The cost of that choice is exactly this: a row
    // written by a NEWER release and read by this one after a rollback carries
    // a key with no handler. Failing here names the problem; passing it through
    // fails later inside a switch that falls off the end.
    expect(() => toToolJob(row({ toolKey: 'image.rotate' }))).toThrow(/image\.rotate/);
  });

  it('refuses a status the running build does not know', () => {
    expect(() => toToolJob(row({ status: 'transcoding' }))).toThrow(/transcoding/);
  });

  it('preserves the version, which every write depends on', () => {
    // Dropping it would silently default the optimistic lock to 0, and every
    // update would then either always or never apply.
    expect(toToolJob(row({ version: 7 })).version).toBe(7);
  });

  it('keeps the status as the vocabulary spells it', () => {
    expect(toToolJob(row({ status: 'uploading' })).status).toBe(ToolJobStatus.Uploading);
  });
});

describe('toToolInputReference', () => {
  function inputRow(overrides: Partial<ToolJobInputRow> = {}): ToolJobInputRow {
    return {
      id: '33333333-3333-4333-8333-333333333333',
      jobId: '11111111-1111-4111-8111-111111111111',
      inputOrder: 0,
      telegramFileId: 'file-abc',
      telegramFileUniqueId: 'uniq-abc',
      declaredFileName: null,
      declaredMimeType: null,
      declaredSize: null,
      createdAt: new Date('2026-08-05T10:00:00Z'),
      ...overrides,
    };
  }

  it('carries the Telegram reference and nothing else', () => {
    // No path and no URL is the property that lets these rows exist at all.
    const reference = toToolInputReference(inputRow());
    expect(reference.fileId).toBe('file-abc');
    expect(JSON.stringify(reference)).not.toMatch(/https?:\/\//);
  });

  it('rebuilds the sent-at ordering from the stored order, not the clock', () => {
    // `receivedAtMs` is what preserves page order for images-to-PDF. Two photos
    // in one album are written within the same millisecond, so a timestamp
    // cannot order them and the explicit column has to.
    const first = toToolInputReference(inputRow({ inputOrder: 0 }));
    const second = toToolInputReference(inputRow({ inputOrder: 1 }));
    expect(second.receivedAtMs).toBeGreaterThan(first.receivedAtMs);
  });

  it('keeps a declared filename as metadata and never as a path', () => {
    const reference = toToolInputReference(
      inputRow({ declaredFileName: '../../etc/passwd', declaredMimeType: 'image/png' }),
    );
    // Preserved verbatim on purpose — it is shown back to the user and used to
    // pick an extension. The workspace generates its own names, so this string
    // never reaches a filesystem call.
    expect(reference.originalName).toBe('../../etc/passwd');
    expect(reference.declaredMimeType).toBe('image/png');
  });
});
