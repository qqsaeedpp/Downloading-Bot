import { OperationCancelledError, OperationTimeoutError } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { EngineFailureCode } from './engine-error.js';
import { YtDlpErrorMapper } from './ytdlp-error-mapper.js';
import { matchesStaleSession } from './ytdlp-error-patterns.js';

const mapper = new YtDlpErrorMapper();

function mapStderr(stderr: string) {
  return mapper.map({ exitCode: 1, signal: null, stderr });
}

describe('YtDlpErrorMapper — message classification', () => {
  it.each([
    [
      'ERROR: [Instagram] Requested content is not available, rate-limit reached or login required',
      EngineFailureCode.LoginRequired,
    ],
    ['ERROR: [twitter] 123: You need to log in', EngineFailureCode.LoginRequired],
    ['ERROR: [Instagram] abc: This account is private', EngineFailureCode.PrivateMedia],
    ['ERROR: [twitter] 1: Video unavailable', EngineFailureCode.MediaNotFound],
    [
      'ERROR: unable to download webpage: HTTP Error 404: Not Found',
      EngineFailureCode.MediaNotFound,
    ],
    [
      'ERROR: The uploader has not made this video available in your country',
      EngineFailureCode.GeoRestricted,
    ],
    ['ERROR: HTTP Error 429: Too Many Requests', EngineFailureCode.RateLimited],
    ['ERROR: Requested format is not available', EngineFailureCode.FormatUnavailable],
    ['ERROR: [Pinterest] abc: No video formats found!', EngineFailureCode.FormatUnavailable],
    ['ERROR: File is larger than max-filesize (600.00MiB)', EngineFailureCode.MediaTooLarge],
    ['ERROR: Unsupported URL: https://example.test/x', EngineFailureCode.UnsupportedPlatform],
    ['ERROR: [download] read operation timed out', EngineFailureCode.DownloadTimeout],
    [
      'ERROR: unable to download video data: Connection reset by peer',
      EngineFailureCode.DownloadFailed,
    ],
    ['OSError: [Errno 28] No space left on device', EngineFailureCode.InsufficientStorage],
  ])('maps %s', (stderr, expected) => {
    expect(mapStderr(stderr).code).toBe(expected);
  });

  it('falls back to a retryable download failure when nothing matches', () => {
    const error = mapStderr('ERROR: something nobody has seen before');
    expect(error.code).toBe(EngineFailureCode.DownloadFailed);
    expect(error.retryable).toBe(true);
  });
});

describe('YtDlpErrorMapper — retry disposition', () => {
  it('does not retry a permanent failure', () => {
    // Asking twice does not make a private post public; it only burns a worker
    // slot and hammers an extractor that already said no.
    expect(mapStderr('ERROR: This account is private').retryable).toBe(false);
    expect(mapStderr('ERROR: Video unavailable').retryable).toBe(false);
    expect(mapStderr('ERROR: File is larger than max-filesize').retryable).toBe(false);
  });

  it('retries a transient failure', () => {
    expect(mapStderr('ERROR: HTTP Error 429: Too Many Requests').retryable).toBe(true);
    expect(mapStderr('ERROR: read operation timed out').retryable).toBe(true);
  });
});

describe('YtDlpErrorMapper — how the process ended outranks what it printed', () => {
  it('reports a timeout when our own watchdog aborted it', () => {
    const error = mapper.map({
      exitCode: null,
      signal: 'SIGKILL',
      stderr: 'ERROR: This account is private',
      cause: new OperationTimeoutError(1_000, 'download'),
    });
    // yt-dlp's parting words are whatever it managed to print; the abort reason
    // is the truth.
    expect(error.code).toBe(EngineFailureCode.DownloadTimeout);
  });

  it('reports a cancellation when the user stopped it', () => {
    const error = mapper.map({
      exitCode: null,
      signal: 'SIGKILL',
      stderr: '',
      cause: new OperationCancelledError('user cancelled'),
    });
    expect(error.code).toBe(EngineFailureCode.Cancelled);
  });

  it('treats a bare SIGKILL with no output as a retryable failure', () => {
    // This is what an OOM kill looks like from the outside.
    const error = mapper.map({ exitCode: null, signal: 'SIGKILL', stderr: '' });
    expect(error.code).toBe(EngineFailureCode.DownloadFailed);
    expect(error.retryable).toBe(true);
  });
});

describe('YtDlpErrorMapper — output sanitisation', () => {
  it('keeps only the ERROR lines and clips the result', () => {
    const noisy = [
      ...Array.from({ length: 200 }, (_, i) => `[download] fragment ${i}`),
      'WARNING: something',
      'ERROR: Video unavailable',
    ].join('\n');

    const message = mapStderr(noisy).message;
    expect(message).toContain('Video unavailable');
    expect(message).not.toContain('fragment 100');
    expect(message.length).toBeLessThanOrEqual(400);
  });

  it('never lets an unbounded stderr through', () => {
    // yt-dlp echoes full request URLs — cookies included — so an unbounded
    // message would put a session token in the database.
    const huge = `ERROR: ${'x'.repeat(5_000)}`;
    expect(mapStderr(huge).message.length).toBeLessThanOrEqual(400);
  });
});

describe('matchesStaleSession', () => {
  it.each([
    'ERROR: [Instagram] Requested content is not available, rate-limit reached or login required',
    'ERROR: HTTP Error 404: Not Found',
    'ERROR: HTTP Error 401: Unauthorized',
    'ERROR: login required',
  ])('recognises %s as a possible dead session', (message) => {
    // A stale session is WORSE than none: Instagram answers an invalidated
    // sessionid with a flat 404 on a reel that resolves fine anonymously.
    expect(matchesStaleSession(message)).toBe(true);
  });

  it('does not treat an ordinary failure as a session problem', () => {
    expect(matchesStaleSession('ERROR: Requested format is not available')).toBe(false);
    expect(matchesStaleSession('ERROR: No space left on device')).toBe(false);
  });
});
