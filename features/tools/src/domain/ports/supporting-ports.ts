import type { ToolJobPayload } from '@tgtools/tool-contracts';

/**
 * The small ports the tool use cases depend on but do not own.
 *
 * Kept apart from the repository because these are about REACHING other
 * processes — the worker holding a running job, the queue a job is placed on —
 * rather than about storing one.
 */

/**
 * Broadcasts "stop job X" to whichever worker is running it.
 *
 * The bot publishes; the tools worker subscribes. Delivery is best-effort by
 * design: the message is worthless a second after it is sent, only the one
 * worker holding that job cares, and the `cancelled` row is the durable record.
 * A missed message costs a conversion that finishes and is thrown away, not a
 * wrong outcome.
 */
export interface ToolCancellationBus {
  publishCancel(jobId: string): Promise<void>;
  /** Returns an unsubscribe function. Only the worker calls this. */
  subscribeCancel(handler: (jobId: string) => void): Promise<() => Promise<void>>;
}

/**
 * Where a built job is handed off.
 *
 * A port rather than a BullMQ `Queue` directly because the use case above it
 * decides the per-user ceiling and the row lifecycle, and neither of those is
 * worth a Redis to test.
 */
export interface ToolQueuePort {
  /** Routes by family: each of the four has its own queue and concurrency. */
  enqueue(payload: ToolJobPayload): Promise<void>;
}
