import { TOOL_JOB_STATUS_VALUES, ToolJobStatus } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TOOL_STATUSES,
  assertToolTransition,
  canToolTransition,
  isToolJobTerminal,
} from './tool-job-status.js';

describe('canToolTransition', () => {
  it('walks the ordinary lifecycle of a job that takes a file', () => {
    const path = [
      ToolJobStatus.Pending,
      ToolJobStatus.Queued,
      ToolJobStatus.Receiving,
      ToolJobStatus.Processing,
      ToolJobStatus.Uploading,
      ToolJobStatus.Completed,
    ] as const;

    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i];
      const to = path[i + 1];
      expect(from && to && canToolTransition(from, to), `${String(from)} -> ${String(to)}`).toBe(
        true,
      );
    }
  });

  it('lets a QR job skip receiving, because it is built from text', () => {
    // QR takes no input file at all (`expectedInputCount` says {min: 0, max: 0}).
    // Forcing it through `receiving` would mean either a lie in the status the
    // user is shown or an illegal transition on the one tool that has nothing
    // to receive.
    expect(canToolTransition(ToolJobStatus.Queued, ToolJobStatus.Processing)).toBe(true);
  });

  it('never walks a job backwards', () => {
    // Two deliveries of the same queue message, or a cancel racing a
    // completion, would otherwise re-run work that already finished — and for
    // these tools that means sending the user a second copy of their file.
    expect(canToolTransition(ToolJobStatus.Completed, ToolJobStatus.Processing)).toBe(false);
    expect(canToolTransition(ToolJobStatus.Uploading, ToolJobStatus.Receiving)).toBe(false);
    expect(canToolTransition(ToolJobStatus.Processing, ToolJobStatus.Pending)).toBe(false);
  });

  it('returns a live job to queued so an already-scheduled retry stays legal', () => {
    // The bug this exists to prevent: a transient failure — Telegram briefly
    // refusing getFile — writes `failed`, BullMQ runs the attempt it had
    // already scheduled, and that attempt cannot legally move a terminal job.
    // The result is a job that is retried and can never report the outcome.
    for (const live of [
      ToolJobStatus.Receiving,
      ToolJobStatus.Processing,
      ToolJobStatus.Uploading,
    ]) {
      expect(canToolTransition(live, ToolJobStatus.Queued), live).toBe(true);
    }
  });

  it('allows failure, cancellation and expiry from every live status', () => {
    const live = TOOL_JOB_STATUS_VALUES.filter((status) => !isToolJobTerminal(status));
    for (const from of live) {
      for (const to of [ToolJobStatus.Failed, ToolJobStatus.Cancelled, ToolJobStatus.Expired]) {
        expect(canToolTransition(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('allows nothing at all out of a terminal status', () => {
    const terminal = TOOL_JOB_STATUS_VALUES.filter((status) => isToolJobTerminal(status));
    expect(terminal.length).toBeGreaterThan(0);

    for (const from of terminal) {
      for (const to of TOOL_JOB_STATUS_VALUES) {
        if (from === to) continue;
        expect(canToolTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('treats re-applying the same status as legal', () => {
    // A duplicate queue delivery re-reports the status it already wrote. That
    // is idempotence, not a violation, and throwing would fail a job for
    // succeeding twice.
    for (const status of TOOL_JOB_STATUS_VALUES) {
      expect(canToolTransition(status, status), status).toBe(true);
    }
  });

  it('covers every status in the vocabulary', () => {
    // A status added to `@tgtools/shared` but not to the table here would throw
    // on its first use — from a lookup returning undefined, with a message
    // about `.includes` rather than about the missing state.
    for (const from of TOOL_JOB_STATUS_VALUES) {
      expect(() => canToolTransition(from, ToolJobStatus.Failed), from).not.toThrow();
    }
  });
});

describe('assertToolTransition', () => {
  it('names both ends in the error, so a log line explains itself', () => {
    expect(() => {
      assertToolTransition(ToolJobStatus.Completed, ToolJobStatus.Processing);
    }).toThrow(/completed.*processing/);
  });
});

describe('ACTIVE_TOOL_STATUSES', () => {
  it('counts exactly the statuses that occupy capacity', () => {
    // This drives the per-user ceiling. Including a terminal status would let
    // one user's finished jobs lock them out of the bot forever.
    for (const status of ACTIVE_TOOL_STATUSES) {
      expect(isToolJobTerminal(status), status).toBe(false);
    }
    expect(ACTIVE_TOOL_STATUSES).toContain(ToolJobStatus.Pending);
    expect(ACTIVE_TOOL_STATUSES).toContain(ToolJobStatus.Processing);
  });
});
