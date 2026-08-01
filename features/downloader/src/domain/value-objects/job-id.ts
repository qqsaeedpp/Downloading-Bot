import { isUuid } from '@tgtools/shared';
import { DownloadError } from '../errors/download-error.js';
import { DownloadFailureCode } from '../errors/download-failure-code.js';

/**
 * A job has two identifiers, and the reason is Telegram's.
 *
 * `callback_data` is capped at 64 bytes. A UUID is 36 of them, and the callback
 * also has to carry an action and an option id, so the full identifier does not
 * fit. `shortId` is what travels in a button; `id` is what everything else uses.
 * Keeping both on the entity — instead of deriving one from the other — means
 * the short form can be rotated or lengthened later without touching the
 * primary key.
 */
export interface JobIdentity {
  readonly id: string;
  readonly shortId: string;
}

/** Long enough that guessing another user's job is not worth attempting. */
export const SHORT_ID_LENGTH = 10;

export function assertJobId(value: string): string {
  if (!isUuid(value)) {
    throw new DownloadError(DownloadFailureCode.InternalError, 'Job id is not a UUID', {
      context: { value },
    });
  }
  return value;
}

const SHORT_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6,16}$/;

export function isValidShortId(value: string): boolean {
  return SHORT_ID_PATTERN.test(value);
}
