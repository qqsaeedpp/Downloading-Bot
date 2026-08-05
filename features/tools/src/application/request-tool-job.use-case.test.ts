import { SequentialIdGenerator, ToolJobStatus, createNoopLogger } from '@tgtools/shared';
import type { ToolJobPayload, ToolOperation } from '@tgtools/tool-contracts';
import { parseToolJobPayload } from '@tgtools/tool-contracts';
import { describe, expect, it } from 'vitest';
import type { ToolJob } from '../domain/tool-job.js';
import type {
  CreateToolJobInput,
  ToolJobRepository,
  UpdateToolJobStatusInput,
} from '../domain/ports/tool-job.repository.js';
import { RequestToolJobUseCase } from './request-tool-job.use-case.js';

class FakeRepository implements Partial<ToolJobRepository> {
  readonly created: CreateToolJobInput[] = [];
  readonly statuses: UpdateToolJobStatusInput[] = [];
  activeCount = 0;
  statusWriteSucceeds = true;

  countActiveByUser(): Promise<number> {
    return Promise.resolve(this.activeCount);
  }

  create(input: CreateToolJobInput): Promise<ToolJob> {
    this.created.push(input);
    return Promise.resolve({
      id: input.id,
      shortId: input.shortId,
      userId: input.userId,
      telegramChatId: input.telegramChatId,
      telegramStatusMessageId: input.telegramStatusMessageId,
      toolKey: input.toolKey,
      status: ToolJobStatus.Pending,
      progressPercent: 0,
      output: undefined,
      errorCode: undefined,
      errorMessageSafe: undefined,
      attemptCount: 0,
      createdAt: new Date(0),
      expiresAt: input.expiresAt,
      version: 0,
    });
  }

  updateStatus(input: UpdateToolJobStatusInput): Promise<boolean> {
    this.statuses.push(input);
    return Promise.resolve(this.statusWriteSucceeds);
  }
}

class FakeQueue {
  readonly enqueued: ToolJobPayload[] = [];
  fails = false;

  enqueue(payload: ToolJobPayload): Promise<void> {
    if (this.fails) return Promise.reject(new Error('redis is down'));
    this.enqueued.push(payload);
    return Promise.resolve();
  }
}

const WIFI_QR: ToolOperation = {
  tool: 'qr.generate',
  content: { kind: 'wifi', ssid: 'Babaee-Home', password: 'hunter2-secret', security: 'WPA' },
  format: 'png',
  size: 512,
  errorCorrection: 'M',
};

function build(overrides: { maxActive?: number } = {}) {
  const repository = new FakeRepository();
  const queue = new FakeQueue();
  const useCase = new RequestToolJobUseCase({
    repository: repository as unknown as ToolJobRepository,
    queue,
    ids: new SequentialIdGenerator(),
    clock: { now: () => new Date(1_000), monotonicMs: () => 0 },
    logger: createNoopLogger(),
    maxActiveJobsPerUser: overrides.maxActive ?? 2,
    jobTimeoutMs: 60_000,
  });
  return { repository, queue, useCase };
}

function request(operation: ToolOperation = { tool: 'video.remove_audio' }) {
  return {
    userId: 'user-1',
    telegramUserId: 555,
    telegramChatId: 777,
    statusMessageId: 9,
    requestId: 'req-1',
    tool: operation.tool,
    operation,
    inputs: [{ fileId: 'f1', fileUniqueId: 'u1', receivedAtMs: 5 }],
  };
}

describe('RequestToolJobUseCase', () => {
  it('writes the row BEFORE the queue message', async () => {
    // The other order is unrecoverable: a message referring to a row that does
    // not exist is a job the worker dequeues, cannot find and discards — with
    // the user already told it was accepted.
    const { repository, queue, useCase } = build();
    await useCase.execute(request());

    expect(repository.created).toHaveLength(1);
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.jobId).toBe(repository.created[0]?.id);
  });

  it('enqueues a payload the worker will actually accept', async () => {
    // Both sides parse this schema. A payload built here that fails there is a
    // job that dies on arrival with no user-visible explanation.
    const { queue, useCase } = build();
    await useCase.execute(request());

    expect(parseToolJobPayload(queue.enqueued[0]).ok).toBe(true);
  });

  it('refuses a user who is already at the ceiling', async () => {
    // The only thing between one user and the whole worker: video runs at a
    // concurrency of 1, so unbounded requests stall the queue for everyone.
    const { repository, queue, useCase } = build({ maxActive: 2 });
    repository.activeCount = 2;

    const result = await useCase.execute(request());

    expect(result).toEqual({ ok: false, reason: 'too-many-active' });
    expect(repository.created).toHaveLength(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('marks the job queued before handing it off', async () => {
    // The worker refuses a job whose row is still `pending`? No — but it does
    // check for a TERMINAL status, and a row left at `pending` never shows the
    // user that anything happened.
    const { repository, useCase } = build();
    await useCase.execute(request());

    expect(repository.statuses[0]?.status).toBe(ToolJobStatus.Queued);
  });

  it('does not enqueue when the row could not be moved to queued', async () => {
    // Enqueuing anyway produces a job the worker may refuse on sight.
    const { repository, queue, useCase } = build();
    repository.statusWriteSucceeds = false;

    const result = await useCase.execute(request());

    expect(result.ok).toBe(false);
    expect(queue.enqueued).toHaveLength(0);
  });

  it('keeps the QR content out of the row but puts it on the queue', async () => {
    // The two halves of the privacy rule, in one place. The queue is where the
    // content legitimately lives — for as long as the job takes and nowhere
    // else. The row has no expiry, so it gets the redacted form.
    const { repository, queue, useCase } = build();
    await useCase.execute(request(WIFI_QR));

    const stored = JSON.stringify(repository.created[0]?.storableOperation);
    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('Babaee-Home');

    // The worker cannot render a code it was not given.
    expect(JSON.stringify(queue.enqueued[0]?.operation)).toContain('hunter2');
  });

  it('gives every job an expiry, so a crash cannot strand it forever', async () => {
    // Without one the maintenance sweep has nothing to select on, and the row
    // counts against its owner's ceiling permanently.
    const { repository, useCase } = build();
    await useCase.execute(request());

    expect(repository.created[0]?.expiresAt).toEqual(new Date(61_000));
  });

  it('propagates an enqueue failure rather than reporting success', async () => {
    // The user must not be shown "queued" for a job that is not.
    const { queue, useCase } = build();
    queue.fails = true;

    await expect(useCase.execute(request())).rejects.toThrow();
  });
});
