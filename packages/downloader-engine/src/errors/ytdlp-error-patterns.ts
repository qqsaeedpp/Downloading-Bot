import { EngineFailureCode } from './engine-error.js';

/**
 * yt-dlp reports almost everything as exit code 1 with a prose message, so
 * classification has to read that prose. Every pattern the codebase relies on
 * lives here, in one list, with a unit test per entry — because the day an
 * extractor rewords a message, this file is the only place that needs to change
 * and the failing test tells you so.
 *
 * ORDER IS SIGNIFICANT: the first match wins. Several of these messages share
 * phrases — "not available" appears in a geo-block, a deleted post and a
 * missing format — so the specific entries come first and the general ones
 * last. Getting the order wrong does not fail anything loudly; it just tells
 * the user "this post was deleted" when the real answer was "that quality is
 * gone, pick another".
 */
export interface YtDlpErrorPattern {
  readonly code: EngineFailureCode;
  readonly pattern: RegExp;
  /** Why this phrase means that code — the part a future reader cannot guess. */
  readonly reason: string;
}

export const YTDLP_ERROR_PATTERNS: readonly YtDlpErrorPattern[] = [
  {
    code: EngineFailureCode.LoginRequired,
    pattern:
      /requested content is not available|login required|use --cookies|cookies-from-browser|you need to log in|sign in to confirm|rate-limit reached or login required|main webpage is locked behind the login page/i,
    reason: 'Instagram, X and TikTok all funnel their auth walls into these phrasings.',
  },
  {
    code: EngineFailureCode.PrivateMedia,
    pattern:
      /private (?:video|account|profile|post)|this (?:post|account) is private|restricted video|only available to|account is private/i,
    reason: 'The content exists but the owner limited who may see it.',
  },
  {
    code: EngineFailureCode.GeoRestricted,
    pattern:
      /not available (?:from|in) your (?:country|location)|not made this video available in your (?:country|location)|geo.?restrict|blocked in your country|not available in your region/i,
    reason: 'A different exit node would help; another attempt from here would not.',
  },
  {
    // Ahead of MEDIA_NOT_FOUND: "Requested format is not available" contains
    // "not available", and reporting it as a deleted post sends the user away
    // instead of back to the keyboard to pick another quality.
    code: EngineFailureCode.FormatUnavailable,
    pattern:
      /requested format (?:is )?not available|no video formats found|no formats found|no video could be found|requested format is not available/i,
    reason: 'The selector chain ran out of fallbacks, or the post carries no media.',
  },
  {
    code: EngineFailureCode.MediaTooLarge,
    pattern: /file is larger than max-filesize|exceeds the maximum|larger than max/i,
    reason: "yt-dlp's own --max-filesize refusal, distinct from the runtime watchdog.",
  },
  {
    code: EngineFailureCode.RateLimited,
    pattern: /http error 429|too many requests|rate.?limit(?:ed)?\b/i,
    reason: 'Transient by definition — backing off is exactly the right response.',
  },
  {
    code: EngineFailureCode.MediaNotFound,
    pattern:
      /video unavailable|is unavailable|no longer exists|no longer available|removed by the user|has been deleted|unable to extract .*(?:post|tweet|pin)|http error 404|page not found|does not exist|not found/i,
    reason: 'Deleted or never existed; a retry cannot conjure it back.',
  },
  {
    code: EngineFailureCode.UnsupportedPlatform,
    pattern: /unsupported url|no suitable extractor|is not a valid url/i,
    reason: 'No extractor claimed the URL, whatever our registry believed.',
  },
  {
    code: EngineFailureCode.InsufficientStorage,
    pattern: /no space left on device|disk quota exceeded/i,
    reason: 'Retrying makes it worse, not better; the operator has to intervene.',
  },
  {
    code: EngineFailureCode.ToolchainMissing,
    pattern: /ffmpeg (?:not found|is not installed)|command not found|\benoent\b/i,
    reason: 'A misconfigured image, not a media problem.',
  },
  {
    code: EngineFailureCode.DownloadTimeout,
    pattern: /timed out|\btimeout\b|read operation timed out/i,
    reason: 'Network stalled. Worth another attempt.',
  },
  {
    code: EngineFailureCode.DownloadFailed,
    pattern:
      /unable to download|connection (?:reset|refused|aborted)|temporary failure in name resolution|network is unreachable|remote end closed|incomplete read|\bssl\b|handshake/i,
    reason: 'Transport-level failure, generally transient.',
  },
];

/**
 * Phrases that mean "this attempt was authenticated and the session is bad".
 *
 * A stale session is worse than no session at all — Instagram answers an
 * invalidated `sessionid` with a flat 404 on a reel that resolves fine
 * anonymously — so these are the cases where dropping the cookies and trying
 * once more is the right move rather than a shot in the dark.
 */
export const STALE_SESSION_PATTERNS: readonly RegExp[] = [
  /login required/i,
  /requested content is not available/i,
  /rate-limit reached or login required/i,
  /http error 40[13]/i,
  /http error 404/i,
  /unable to extract shared data/i,
  /cookies are no longer valid/i,
  /main webpage is locked behind the login page/i,
];

export function matchesStaleSession(message: string): boolean {
  return STALE_SESSION_PATTERNS.some((pattern) => pattern.test(message));
}
