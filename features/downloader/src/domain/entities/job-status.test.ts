import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  DownloadJobStatus,
  InvalidStatusTransitionError,
  TERMINAL_STATUSES,
  assertTransition,
  canTransition,
  isTerminal,
} from './job-status.js';

describe('the download job state machine', () => {
  it('walks the happy path end to end', () => {
    const path = [
      DownloadJobStatus.Pending,
      DownloadJobStatus.Inspecting,
      DownloadJobStatus.AwaitingSelection,
      DownloadJobStatus.Queued,
      DownloadJobStatus.Downloading,
      DownloadJobStatus.Processing,
      DownloadJobStatus.Uploading,
      DownloadJobStatus.Completed,
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    }
  });

  it('refuses to walk backwards', () => {
    // A redelivered queue message must not be able to move a finished job back
    // into `downloading` and re-fetch a file the user already has.
    expect(canTransition(DownloadJobStatus.Completed, DownloadJobStatus.Downloading)).toBe(false);
    expect(canTransition(DownloadJobStatus.Uploading, DownloadJobStatus.Queued)).toBe(false);
    expect(canTransition(DownloadJobStatus.Downloading, DownloadJobStatus.AwaitingSelection)).toBe(
      false,
    );
  });

  it('refuses to skip a step', () => {
    expect(canTransition(DownloadJobStatus.Queued, DownloadJobStatus.Completed)).toBe(false);
    expect(canTransition(DownloadJobStatus.Pending, DownloadJobStatus.Downloading)).toBe(false);
  });

  it('allows failure and cancellation from every live status', () => {
    const live = [
      DownloadJobStatus.Pending,
      DownloadJobStatus.Inspecting,
      DownloadJobStatus.AwaitingSelection,
      DownloadJobStatus.Queued,
      DownloadJobStatus.Downloading,
      DownloadJobStatus.Processing,
      DownloadJobStatus.Uploading,
    ];
    for (const status of live) {
      expect(canTransition(status, DownloadJobStatus.Failed), `${status} -> failed`).toBe(true);
      expect(canTransition(status, DownloadJobStatus.Cancelled), `${status} -> cancelled`).toBe(
        true,
      );
      expect(canTransition(status, DownloadJobStatus.Expired), `${status} -> expired`).toBe(true);
    }
  });

  it('lets nothing follow a terminal status', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of Object.values(DownloadJobStatus)) {
        if (target === terminal) continue;
        expect(canTransition(terminal, target), `${terminal} -> ${target}`).toBe(false);
      }
    }
  });

  it('treats re-applying the same status as a no-op, not a violation', () => {
    // A retried write of the state it already holds is idempotent, not a bug.
    expect(canTransition(DownloadJobStatus.Downloading, DownloadJobStatus.Downloading)).toBe(true);
  });

  it('throws with both ends named when a transition is rejected', () => {
    let thrown: unknown;
    try {
      assertTransition(DownloadJobStatus.Completed, DownloadJobStatus.Downloading);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidStatusTransitionError);
    expect((thrown as InvalidStatusTransitionError).from).toBe(DownloadJobStatus.Completed);
    expect((thrown as InvalidStatusTransitionError).to).toBe(DownloadJobStatus.Downloading);
  });

  it('counts exactly the unfinished statuses as active', () => {
    // This list drives the per-user concurrency limit; a terminal status leaking
    // into it would lock a user out permanently.
    for (const status of ACTIVE_STATUSES) expect(isTerminal(status)).toBe(false);
    expect(ACTIVE_STATUSES).not.toContain(DownloadJobStatus.AwaitingSelection);
    expect(ACTIVE_STATUSES).toHaveLength(6);
  });
});
