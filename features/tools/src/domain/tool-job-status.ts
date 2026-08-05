import {
  AppError,
  TOOL_JOB_STATUS_VALUES,
  ToolJobStatus,
  isTerminalToolJobStatus,
} from '@tgtools/shared';

/**
 * The tool job state machine.
 *
 * The vocabulary itself lives in `@tgtools/shared` because the database, the
 * bot and the worker all name these states. What lives HERE is which moves
 * between them are legal, which is a domain rule and not a shared constant.
 *
 * Every transition goes through {@link assertToolTransition} while the
 * repository asserts the row's `version` at the same time. Neither check
 * subsumes the other: the guard rejects a nonsensical move (a bug), the version
 * predicate rejects a stale one (a race).
 */

/** Nothing follows these. Re-exported from the shared predicate, not re-derived. */
export function isToolJobTerminal(status: ToolJobStatus): boolean {
  return isTerminalToolJobStatus(status);
}

/**
 * Counts against the per-user ceiling.
 *
 * Derived from the terminal predicate rather than listed by hand, so a status
 * added later is counted as active until someone deliberately says otherwise —
 * the safe direction to be wrong in, since the alternative is a user who can
 * queue work without limit.
 */
export const ACTIVE_TOOL_STATUSES: readonly ToolJobStatus[] = TOOL_JOB_STATUS_VALUES.filter(
  (status) => !isTerminalToolJobStatus(status),
);

/**
 * Failure, cancellation and expiry may interrupt any live status, so they are
 * added to every non-terminal entry rather than written out one by one.
 */
const INTERRUPTIONS: readonly ToolJobStatus[] = [
  ToolJobStatus.Failed,
  ToolJobStatus.Cancelled,
  ToolJobStatus.Expired,
];

/**
 * A transient failure returns the job to `queued` rather than ending it.
 *
 * This edge is load-bearing and easy to leave out. BullMQ schedules the retry
 * BEFORE the processor decides what the failure meant, so a processor that
 * wrote `failed` on a temporary Telegram error would leave the job terminal
 * while a second attempt was already on its way — and that attempt could then
 * make no legal move at all. The job would be retried and never able to report
 * how it went.
 */
const RESTART: readonly ToolJobStatus[] = [ToolJobStatus.Queued];

const ALLOWED_TRANSITIONS: Readonly<Record<ToolJobStatus, readonly ToolJobStatus[]>> = {
  [ToolJobStatus.Pending]: [ToolJobStatus.Queued, ...INTERRUPTIONS],
  // `processing` directly, with no `receiving`, is how QR runs: it is built from
  // text and takes no input file, so there is nothing to receive.
  [ToolJobStatus.Queued]: [ToolJobStatus.Receiving, ToolJobStatus.Processing, ...INTERRUPTIONS],
  [ToolJobStatus.Receiving]: [ToolJobStatus.Processing, ...RESTART, ...INTERRUPTIONS],
  [ToolJobStatus.Processing]: [ToolJobStatus.Uploading, ...RESTART, ...INTERRUPTIONS],
  [ToolJobStatus.Uploading]: [ToolJobStatus.Completed, ...RESTART, ...INTERRUPTIONS],
  [ToolJobStatus.Completed]: [],
  [ToolJobStatus.Failed]: [],
  [ToolJobStatus.Cancelled]: [],
  [ToolJobStatus.Expired]: [],
};

export class InvalidToolTransitionError extends AppError {
  readonly code = 'INVALID_TOOL_STATUS_TRANSITION';

  constructor(
    readonly from: ToolJobStatus,
    readonly to: ToolJobStatus,
  ) {
    super(`A tool job cannot move from "${from}" to "${to}"`, { context: { from, to } });
  }
}

export function canToolTransition(from: ToolJobStatus, to: ToolJobStatus): boolean {
  // Idempotent re-application. A duplicate queue delivery re-reports the status
  // it already wrote, and failing a job for succeeding twice helps nobody.
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertToolTransition(from: ToolJobStatus, to: ToolJobStatus): void {
  if (!canToolTransition(from, to)) throw new InvalidToolTransitionError(from, to);
}
