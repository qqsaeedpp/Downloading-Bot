import type { Db } from '@tgtools/database';
import { downloadEvents } from '@tgtools/database';
import type { Clock, IdGenerator, Logger } from '@tgtools/shared';
import { describeError, truncateForStorage } from '@tgtools/shared';
import type { DownloadEventRepository } from '../../domain/ports/supporting-ports.js';

/** Nothing longer than this reaches the JSONB column. */
const MAX_STRING_LENGTH = 300;
const MAX_KEYS = 20;

export class DrizzleDownloadEventRepository implements DownloadEventRepository {
  constructor(
    private readonly db: Db,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async record(input: {
    readonly jobId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<void> {
    try {
      await this.db.insert(downloadEvents).values({
        id: this.ids.uuid(),
        jobId: input.jobId,
        eventType: input.eventType,
        payload: sanitizePayload(input.payload),
        createdAt: this.clock.now(),
      });
    } catch (error: unknown) {
      // The audit trail is valuable but never worth failing a user's download
      // over — a foreign key violation here means the job row is already gone.
      this.logger.warn('failed to record download event', {
        jobId: input.jobId,
        eventType: input.eventType,
        error: describeError(error),
      });
    }
  }
}

/**
 * Bound what goes into the JSONB column.
 *
 * An unbounded payload is two problems at once: a yt-dlp stderr dump is
 * megabytes of text that nobody will read, and it echoes request URLs that can
 * carry a session token. Only scalars survive, each of them clipped.
 */
export function sanitizePayload(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (keys >= MAX_KEYS) break;
    if (typeof value === 'string') result[key] = truncateForStorage(value, MAX_STRING_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
    else continue; // Objects, arrays and functions are dropped rather than flattened.
    keys += 1;
  }
  return result;
}
