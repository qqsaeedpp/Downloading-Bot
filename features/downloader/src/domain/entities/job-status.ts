import { AppError } from '@tgtools/shared';

export const DownloadJobStatus = {
  Pending: 'pending',
  Inspecting: 'inspecting',
  AwaitingSelection: 'awaiting_selection',
  Queued: 'queued',
  Downloading: 'downloading',
  Processing: 'processing',
  Uploading: 'uploading',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Expired: 'expired',
} as const;

export type DownloadJobStatus = (typeof DownloadJobStatus)[keyof typeof DownloadJobStatus];

/** Nothing follows these. */
export const TERMINAL_STATUSES: ReadonlySet<DownloadJobStatus> = new Set([
  DownloadJobStatus.Completed,
  DownloadJobStatus.Failed,
  DownloadJobStatus.Cancelled,
  DownloadJobStatus.Expired,
]);

/** Counts against the per-user concurrency limit. */
export const ACTIVE_STATUSES: readonly DownloadJobStatus[] = [
  DownloadJobStatus.Pending,
  DownloadJobStatus.Inspecting,
  DownloadJobStatus.Queued,
  DownloadJobStatus.Downloading,
  DownloadJobStatus.Processing,
  DownloadJobStatus.Uploading,
];

/**
 * Failure and cancellation may interrupt any live status, so they are added to
 * every non-terminal entry below rather than listed one by one.
 */
const INTERRUPTIONS: readonly DownloadJobStatus[] = [
  DownloadJobStatus.Failed,
  DownloadJobStatus.Cancelled,
  DownloadJobStatus.Expired,
];

/**
 * The state machine, written out in full.
 *
 * Two deliveries of the same queue message, or a cancel tap racing a completion,
 * would otherwise be able to walk a job backwards — from `completed` to
 * `downloading`, say — and re-download a file that was already sent. Every
 * transition goes through {@link assertTransition}, and the repository asserts
 * the row version at the same time, so a losing writer is rejected rather than
 * silently overwriting.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<DownloadJobStatus, readonly DownloadJobStatus[]>> = {
  [DownloadJobStatus.Pending]: [DownloadJobStatus.Inspecting, ...INTERRUPTIONS],
  [DownloadJobStatus.Inspecting]: [DownloadJobStatus.AwaitingSelection, ...INTERRUPTIONS],
  [DownloadJobStatus.AwaitingSelection]: [DownloadJobStatus.Queued, ...INTERRUPTIONS],
  [DownloadJobStatus.Queued]: [DownloadJobStatus.Downloading, ...INTERRUPTIONS],
  [DownloadJobStatus.Downloading]: [DownloadJobStatus.Processing, ...INTERRUPTIONS],
  // Small files skip normalisation entirely, so uploading may follow either.
  [DownloadJobStatus.Processing]: [DownloadJobStatus.Uploading, ...INTERRUPTIONS],
  [DownloadJobStatus.Uploading]: [DownloadJobStatus.Completed, ...INTERRUPTIONS],
  [DownloadJobStatus.Completed]: [],
  [DownloadJobStatus.Failed]: [],
  [DownloadJobStatus.Cancelled]: [],
  [DownloadJobStatus.Expired]: [],
};

export class InvalidStatusTransitionError extends AppError {
  readonly code = 'INVALID_STATUS_TRANSITION';

  constructor(
    readonly from: DownloadJobStatus,
    readonly to: DownloadJobStatus,
  ) {
    super(`A download job cannot move from "${from}" to "${to}"`, { context: { from, to } });
  }
}

export function canTransition(from: DownloadJobStatus, to: DownloadJobStatus): boolean {
  if (from === to) return true; // Idempotent re-application of the same state.
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DownloadJobStatus, to: DownloadJobStatus): void {
  if (!canTransition(from, to)) throw new InvalidStatusTransitionError(from, to);
}

export function isTerminal(status: DownloadJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
