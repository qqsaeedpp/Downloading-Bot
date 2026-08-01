import { GrammyError, HttpError } from 'grammy';

export type TelegramErrorKind =
  | 'rate_limited'
  | 'not_modified'
  | 'message_unavailable'
  | 'blocked_by_user'
  | 'chat_not_found'
  | 'file_too_large'
  | 'unsupported_content'
  | 'bad_request'
  | 'network'
  | 'server'
  | 'unknown';

export interface TelegramErrorInfo {
  readonly kind: TelegramErrorKind;
  /** Worth trying again as-is. */
  readonly retryable: boolean;
  /** Present on 429; Telegram tells us exactly how long to wait. */
  readonly retryAfterSeconds: number | undefined;
  /** Safe for a log line — never shown to a user. */
  readonly description: string;
}

/**
 * Turn a grammY failure into something the callers can branch on.
 *
 * Telegram signals most of its distinctions in a free-text `description`
 * rather than in the error code, so string matching is unavoidable here. It is
 * confined to this one function, and covered by unit tests, so the rest of the
 * codebase never has to know that.
 */
export function classifyTelegramError(error: unknown): TelegramErrorInfo {
  if (error instanceof HttpError) {
    // The request never reached Telegram: DNS, TLS, a dropped socket.
    return {
      kind: 'network',
      retryable: true,
      retryAfterSeconds: undefined,
      description: error.message,
    };
  }

  if (!(error instanceof GrammyError)) {
    return {
      kind: 'unknown',
      retryable: false,
      retryAfterSeconds: undefined,
      description: error instanceof Error ? error.message : String(error),
    };
  }

  const description = error.description;
  const lowered = description.toLowerCase();

  if (error.error_code === 429) {
    return {
      kind: 'rate_limited',
      retryable: true,
      retryAfterSeconds: error.parameters.retry_after,
      description,
    };
  }

  if (error.error_code >= 500) {
    return { kind: 'server', retryable: true, retryAfterSeconds: undefined, description };
  }

  // Editing a message to the text it already has is not a failure; it is the
  // throttler doing its job. Treating it as one produces a permanent error log
  // for every idle progress tick.
  if (lowered.includes('message is not modified')) {
    return { kind: 'not_modified', retryable: false, retryAfterSeconds: undefined, description };
  }

  if (
    lowered.includes('message to edit not found') ||
    lowered.includes('message to delete not found') ||
    lowered.includes("message can't be edited") ||
    lowered.includes('message identifier is not specified')
  ) {
    return {
      kind: 'message_unavailable',
      retryable: false,
      retryAfterSeconds: undefined,
      description,
    };
  }

  if (lowered.includes('bot was blocked by the user') || lowered.includes('user is deactivated')) {
    return { kind: 'blocked_by_user', retryable: false, retryAfterSeconds: undefined, description };
  }

  if (lowered.includes('chat not found')) {
    return { kind: 'chat_not_found', retryable: false, retryAfterSeconds: undefined, description };
  }

  if (
    lowered.includes('file is too big') ||
    lowered.includes('request entity too large') ||
    lowered.includes('file too large')
  ) {
    return { kind: 'file_too_large', retryable: false, retryAfterSeconds: undefined, description };
  }

  // Telegram accepted the upload but refused to treat it as playable media.
  // Recoverable by re-sending the same bytes as a document.
  if (
    lowered.includes('wrong file identifier') ||
    lowered.includes('failed to get http url content') ||
    lowered.includes('wrong type of the web page content') ||
    lowered.includes('video_note') ||
    lowered.includes('unsupported')
  ) {
    return {
      kind: 'unsupported_content',
      retryable: false,
      retryAfterSeconds: undefined,
      description,
    };
  }

  return { kind: 'bad_request', retryable: false, retryAfterSeconds: undefined, description };
}

/** Grammy already retried 429s; anything still retryable here is worth a job retry. */
export function isRetryableTelegramError(error: unknown): boolean {
  return classifyTelegramError(error).retryable;
}
