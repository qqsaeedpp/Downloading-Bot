/**
 * Every queue the system uses, in one place. Adding a queue means adding a name
 * here, which keeps the Redis key space greppable and stops two features from
 * silently sharing a queue.
 */
export const QueueName = {
  /**
   * The heavy path: yt-dlp, FFmpeg, upload. The only queue currently wired.
   */
  MediaDownload: 'media-download',

  /**
   * Reserved, not yet wired. Inspection runs inline in the bot today because a
   * metadata probe takes seconds and the user is waiting on the answer. The
   * name is claimed here so that moving it behind a queue — if an extractor
   * ever becomes slow enough to matter — is a wiring change rather than a
   * redesign.
   */
  MediaInspect: 'media-inspect',

  /**
   * Reserved, not yet wired. Housekeeping runs on a plain interval in the
   * worker (see `startMaintenanceLoop`): the work is idempotent and cheap, and
   * losing a tick costs nothing because the next one picks up whatever
   * accumulated. A durable schedule would add Redis keys to leak and a
   * repeat-key migration to get wrong, for no benefit.
   */
  Maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QueueName)[keyof typeof QueueName];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.values(QueueName));
