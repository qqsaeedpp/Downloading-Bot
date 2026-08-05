import { OperationCancelledError, createNoopLogger } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { RunningToolJobs } from './running-tool-jobs.js';

function registry(): RunningToolJobs {
  return new RunningToolJobs(createNoopLogger());
}

describe('RunningToolJobs', () => {
  it('aborts the signal belonging to the job that was cancelled', () => {
    // Without this a "cancel" is nothing but a row update: ffmpeg keeps burning
    // CPU until the job timeout fires, minutes later.
    const jobs = registry();
    const controller = jobs.register('job-1');

    expect(controller.signal.aborted).toBe(false);
    expect(jobs.cancel('job-1')).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(OperationCancelledError);
  });

  it('reports false for a job this replica is not running', () => {
    // The cancellation is BROADCAST to every worker, so most replicas will not
    // hold the job. Treating that as a failure would log an error for the
    // normal case on every cancel in a multi-replica deployment.
    expect(registry().cancel('job-on-another-worker')).toBe(false);
  });

  it('does not cancel a job that has already been released', () => {
    // A cancel tap arriving just after the job finished must not abort the
    // NEXT job that reuses the same controller slot.
    const jobs = registry();
    jobs.register('job-1');
    jobs.release('job-1');

    expect(jobs.cancel('job-1')).toBe(false);
    expect(jobs.size).toBe(0);
  });

  it('keeps a separate signal per job', () => {
    // One shared controller would make cancelling any job cancel all of them,
    // and the image queue runs several at once.
    const jobs = registry();
    const first = jobs.register('job-1');
    const second = jobs.register('job-2');

    jobs.cancel('job-1');

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it('aborts everything left when the process is going down', () => {
    // The shutdown path. Jobs that outlast the grace period have to fail
    // cleanly — releasing their queue lock and removing their workspace —
    // rather than being SIGKILLed with a half-written file on the volume.
    const jobs = registry();
    const first = jobs.register('job-1');
    const second = jobs.register('job-2');

    const reason = new OperationCancelledError('Worker is shutting down');
    expect(jobs.abortAll(reason)).toBe(2);

    expect(first.signal.reason).toBe(reason);
    expect(second.signal.reason).toBe(reason);
    expect(jobs.size).toBe(0);
  });

  it('counts what is running, which is what the drain loop waits on', () => {
    const jobs = registry();
    expect(jobs.size).toBe(0);

    jobs.register('job-1');
    jobs.register('job-2');
    expect(jobs.size).toBe(2);

    jobs.release('job-1');
    expect(jobs.size).toBe(1);
  });

  it('replaces the controller when a job id is registered twice', () => {
    // A duplicate queue delivery, or a retry of a job whose first attempt was
    // never released. The SECOND attempt is the live one, so a later cancel has
    // to reach it — leaving the stale controller in place would abort nothing.
    const jobs = registry();
    jobs.register('job-1');
    const retry = jobs.register('job-1');

    expect(jobs.cancel('job-1')).toBe(true);
    expect(retry.signal.aborted).toBe(true);
  });
});
