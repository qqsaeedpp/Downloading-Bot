import { createHash } from 'node:crypto';

/**
 * A media URL can carry a signed CDN token, a session hint or a tracking id in
 * its query string. Logs are shipped, aggregated and read by people who have no
 * business seeing those, so a URL is never logged whole.
 */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '<unparsable-url>';
  }
  const parameterCount = [...url.searchParams.keys()].length;
  const query = parameterCount > 0 ? `?<${parameterCount} params>` : '';
  const credentials = url.username !== '' || url.password !== '' ? '<credentials>@' : '';
  return `${url.protocol}//${credentials}${url.host}${url.pathname}${query}`;
}

/**
 * Origin + path only. This is what gets persisted when `STORE_FULL_SOURCE_URL`
 * is off: enough to recognise a job, not enough to replay someone's signed link.
 */
export function stripUrlQuery(raw: string): string {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return raw;
  }
}

/** Stable cache/lookup key for a URL without storing the URL itself. */
export function hashUrl(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex');
}

/**
 * Truncate a third-party error before it is stored or shown. yt-dlp happily
 * echoes the full request URL — cookies included — into its stderr.
 */
export function truncateForStorage(text: string, maxLength = 500): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}
