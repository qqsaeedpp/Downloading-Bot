/**
 * Pulling links out of whatever a person typed.
 *
 * Kept separate from validation on purpose: this half is forgiving (people
 * paste links inside sentences, wrapped in brackets, with a full stop stuck to
 * the end), and the guard that runs afterwards is not.
 */

/** Deliberately loose — the guard does the real work. */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Characters that end a sentence far more often than they end a URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"«»…]+$/;

export interface ExtractedUrls {
  readonly urls: readonly string[];
  /** The message was a bot command, so any URL in it belongs to that command. */
  readonly isCommand: boolean;
}

export function extractUrls(text: string): ExtractedUrls {
  const trimmed = text.trim();
  // `/start https://...` is a deep link, not a download request. Treating it as
  // one would make every referral link kick off a download.
  const isCommand = trimmed.startsWith('/');

  const matches = trimmed.match(URL_PATTERN) ?? [];
  const cleaned = matches.map(trimTrailingPunctuation).filter((url) => url.length > 0);

  // Preserve first-seen order: when someone sends two links, the first is the
  // one they meant.
  return { urls: [...new Set(cleaned)], isCommand };
}

/**
 * Strip punctuation that ended the sentence rather than the URL, while keeping
 * balanced brackets that are genuinely part of it — Wikipedia-style paths do
 * exist, and chopping their closing paren produces a 404 instead of a page.
 */
export function trimTrailingPunctuation(url: string): string {
  let result = url;
  for (;;) {
    const match = TRAILING_PUNCTUATION.exec(result);
    if (match === null) break;

    const suffix = match[0];
    // A closing bracket is only sentence punctuation when there is no opener to
    // match it: in `https://host/a_(b)` the paren is part of the path, while in
    // `(https://host/a)` the matcher never saw the opener, so the count goes
    // negative and the bracket is dropped.
    if (suffix === ')' && countUnbalanced(result, '(', ')') >= 0) break;
    if (suffix === ']' && countUnbalanced(result, '[', ']') >= 0) break;

    const next = result.slice(0, result.length - suffix.length);
    if (next === result) break;
    result = next;
  }
  return result;
}

function countUnbalanced(value: string, open: string, close: string): number {
  let depth = 0;
  for (const character of value) {
    if (character === open) depth += 1;
    else if (character === close) depth -= 1;
  }
  return depth;
}
