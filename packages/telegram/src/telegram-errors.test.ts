import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { classifyTelegramError, isRetryableTelegramError } from './telegram-errors.js';

/** Build a real GrammyError the way grammY's own `toGrammyError` does. */
function grammyError(
  errorCode: number,
  description: string,
  retryAfterSeconds?: number,
): GrammyError {
  return new GrammyError(
    `Call to 'sendMessage' failed!`,
    {
      ok: false,
      error_code: errorCode,
      description,
      parameters: retryAfterSeconds === undefined ? {} : { retry_after: retryAfterSeconds },
    },
    'sendMessage',
    { chat_id: 1 },
  );
}

describe('classifyTelegramError', () => {
  it('classifies a 429 as rate limited and carries Telegram’s retry_after', () => {
    const info = classifyTelegramError(grammyError(429, 'Too Many Requests: retry after 30', 30));

    expect(info.kind).toBe('rate_limited');
    expect(info.retryable).toBe(true);
    expect(info.retryAfterSeconds).toBe(30);
    expect(info.description).toBe('Too Many Requests: retry after 30');
  });

  it('still classifies a 429 as rate limited when Telegram omits retry_after', () => {
    const info = classifyTelegramError(grammyError(429, 'Too Many Requests'));

    expect(info.kind).toBe('rate_limited');
    expect(info.retryable).toBe(true);
    expect(info.retryAfterSeconds).toBeUndefined();
  });

  it('classifies "message is not modified" as not_modified and does not retry it', () => {
    const info = classifyTelegramError(
      grammyError(400, 'Bad Request: message is not modified: specified new message content...'),
    );

    expect(info.kind).toBe('not_modified');
    expect(info.retryable).toBe(false);
    expect(info.retryAfterSeconds).toBeUndefined();
  });

  it('classifies "message to edit not found" as message_unavailable', () => {
    const info = classifyTelegramError(grammyError(400, 'Bad Request: message to edit not found'));

    expect(info.kind).toBe('message_unavailable');
    expect(info.retryable).toBe(false);
  });

  it('classifies the other message-gone variants as message_unavailable too', () => {
    const descriptions = [
      'Bad Request: message to delete not found',
      "Bad Request: message can't be edited",
      'Bad Request: message identifier is not specified',
    ];

    for (const description of descriptions) {
      expect(classifyTelegramError(grammyError(400, description)).kind).toBe('message_unavailable');
    }
  });

  it('classifies "bot was blocked by the user" as blocked_by_user', () => {
    const info = classifyTelegramError(grammyError(403, 'Forbidden: bot was blocked by the user'));

    expect(info.kind).toBe('blocked_by_user');
    expect(info.retryable).toBe(false);
  });

  it('classifies a deactivated user as blocked_by_user as well', () => {
    expect(classifyTelegramError(grammyError(403, 'Forbidden: user is deactivated')).kind).toBe(
      'blocked_by_user',
    );
  });

  it('classifies "chat not found" as chat_not_found', () => {
    const info = classifyTelegramError(grammyError(400, 'Bad Request: chat not found'));

    expect(info.kind).toBe('chat_not_found');
    expect(info.retryable).toBe(false);
  });

  it('classifies "file is too big" as file_too_large', () => {
    const info = classifyTelegramError(grammyError(400, 'Bad Request: file is too big'));

    expect(info.kind).toBe('file_too_large');
    expect(info.retryable).toBe(false);
  });

  it('classifies a 413 request entity too large as file_too_large', () => {
    expect(classifyTelegramError(grammyError(413, 'Request Entity Too Large')).kind).toBe(
      'file_too_large',
    );
  });

  it('classifies a media rejection as unsupported_content', () => {
    expect(
      classifyTelegramError(
        grammyError(400, 'Bad Request: wrong file identifier/HTTP URL specified'),
      ).kind,
    ).toBe('unsupported_content');
    expect(classifyTelegramError(grammyError(400, 'Bad Request: unsupported file type')).kind).toBe(
      'unsupported_content',
    );
  });

  it('classifies any other 4xx as a plain bad_request', () => {
    const info = classifyTelegramError(grammyError(400, 'Bad Request: something else entirely'));

    expect(info.kind).toBe('bad_request');
    expect(info.retryable).toBe(false);
  });

  it('classifies a 5xx as a retryable server error', () => {
    for (const code of [500, 502, 503]) {
      const info = classifyTelegramError(grammyError(code, 'Internal Server Error'));

      expect(info.kind).toBe('server');
      expect(info.retryable).toBe(true);
      expect(info.retryAfterSeconds).toBeUndefined();
    }
  });

  it('prefers the 429 branch over description matching', () => {
    // A 429 whose text would otherwise look like a permanent failure.
    const info = classifyTelegramError(grammyError(429, 'Too Many Requests: chat not found', 5));

    expect(info.kind).toBe('rate_limited');
    expect(info.retryAfterSeconds).toBe(5);
  });

  it('matches the description case-insensitively', () => {
    expect(classifyTelegramError(grammyError(400, 'Bad Request: CHAT NOT FOUND')).kind).toBe(
      'chat_not_found',
    );
  });

  it('classifies a transport failure as a retryable network error', () => {
    const info = classifyTelegramError(
      new HttpError('Network request for "sendMessage" failed!', new Error('ECONNRESET')),
    );

    expect(info.kind).toBe('network');
    expect(info.retryable).toBe(true);
    expect(info.retryAfterSeconds).toBeUndefined();
    expect(info.description).toContain('sendMessage');
  });

  it('classifies an unrelated Error as unknown and keeps its message for the log', () => {
    const info = classifyTelegramError(new Error('something local broke'));

    expect(info.kind).toBe('unknown');
    expect(info.retryable).toBe(false);
    expect(info.description).toBe('something local broke');
  });

  it('stringifies a thrown non-Error rather than dropping it', () => {
    const info = classifyTelegramError('just a string');

    expect(info.kind).toBe('unknown');
    expect(info.description).toBe('just a string');
  });
});

describe('isRetryableTelegramError', () => {
  it('is true only for rate limits, server errors and network failures', () => {
    expect(isRetryableTelegramError(grammyError(429, 'Too Many Requests', 1))).toBe(true);
    expect(isRetryableTelegramError(grammyError(500, 'Internal Server Error'))).toBe(true);
    expect(isRetryableTelegramError(new HttpError('failed', new Error('ETIMEDOUT')))).toBe(true);

    expect(isRetryableTelegramError(grammyError(400, 'Bad Request: chat not found'))).toBe(false);
    expect(isRetryableTelegramError(new Error('nope'))).toBe(false);
  });
});
