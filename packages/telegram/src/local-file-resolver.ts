import { posix, win32 } from 'node:path';
import { ConfigurationError, isPathInside } from '@tgtools/shared';
import { PUBLIC_BOT_API_ROOT } from './api-root.js';

/**
 * Where a `getFile` result actually lives.
 *
 * The public Bot API answers with a RELATIVE path — `videos/file_12.mp4` — which
 * means nothing until it is pasted into a download URL. A local Bot API server
 * answers with an ABSOLUTE path on its OWN filesystem —
 * `/var/lib/telegram-bot-api/<token>/videos/file_12.mp4` — which is a file to
 * open, not a URL segment.
 *
 * Two variants rather than one string because the failure of conflating them is
 * silent: an absolute path concatenated into the URL template produces a request
 * that can never succeed, and writes the server's internal directory layout —
 * including the bot token, which the local server uses as a directory name —
 * into every log line and error report that carries the URL.
 */
export type ResolvedTelegramFile =
  | { readonly kind: 'local-path'; readonly path: string }
  | { readonly kind: 'remote-url'; readonly url: string };

// Re-exported, not redeclared: see the note in `api-root.ts` on why exactly one
// copy of this string may exist.
export { PUBLIC_BOT_API_ROOT };

/**
 * Stands where the bot token belongs in a returned URL.
 *
 * This module never receives the token and so cannot leak it: what it returns is
 * safe to log, attach to an error or put in a queue payload. {@link withBotToken}
 * is the single place the real credential is substituted in, and its result is
 * not.
 */
export const BOT_TOKEN_PLACEHOLDER = '<bot-token>';

/**
 * Telegram bot tokens have a fixed shape — `<numeric bot id>:<secret>` — which is
 * what makes it possible to strip one out of a path we are about to put in an
 * error message. The local Bot API server stores files under a directory named
 * after the token, so the offending path in a containment failure is exactly the
 * kind of string that must not reach a log aggregator intact.
 */
const BOT_TOKEN_PATTERN = /\d{6,}:[A-Za-z0-9_-]{20,}/g;

function redactToken(value: string): string {
  return value.replace(BOT_TOKEN_PATTERN, BOT_TOKEN_PLACEHOLDER);
}

/**
 * True for a path rooted on the API server's filesystem rather than a URL
 * segment.
 *
 * Both flavours are consulted deliberately. `node:path` resolves to the host's
 * rules, and the host is not the Bot API server: the bot may run on Windows in
 * development while the server it talks to is a Linux container, in which case
 * the platform-native `isAbsolute` would call `/var/lib/...` relative and happily
 * splice a server path into a public URL — the exact bug this module exists to
 * prevent. Asking both is the conservative direction to be wrong in.
 */
function isServerAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function containmentFailure(filePath: string, allowedRoots: readonly string[]): ConfigurationError {
  const safePath = redactToken(filePath);
  const roots = allowedRoots.length === 0 ? '(none configured)' : allowedRoots.join(', ');
  return new ConfigurationError(
    `The Bot API server returned a file at "${safePath}", which lies outside every directory ` +
      `this process is allowed to read (${roots}). This is a deployment problem, not something a ` +
      `user did: the local Bot API server's working directory and the roots configured here have ` +
      `to describe the same mounted volume.`,
    { context: { allowedRoots } },
  );
}

/**
 * Decide whether a `getFile` result names a file on disk or a URL to fetch.
 *
 * The absolute case is never turned into a URL, whatever the caller asks for, and
 * is refused outright unless it lands inside one of `allowedRoots`. A Bot API
 * server is a piece of infrastructure that hands us a filesystem path and we open
 * whatever it names; the root list is what stops a compromised or misconfigured
 * one from pointing at `/etc/shadow`.
 *
 * Containment is decided by {@link isPathInside} — the same predicate
 * `assertContainedPath` applies — rather than by a second implementation here.
 * The async `assertContainedPath` itself is deliberately not used: it calls
 * `realpath`, and the path belongs to the API server's filesystem, which is a
 * different container in every deployment where this matters. A caller that goes
 * on to OPEN the returned path from a process that genuinely shares the volume
 * should still `await assertContainedPath(path, root)` first, which additionally
 * defeats a symlink planted inside the root.
 *
 * The returned `path` may itself contain the bot token as a directory segment,
 * because that is how the local server lays out its storage. Open it; do not log
 * it.
 *
 * @throws ConfigurationError when an absolute path escapes every allowed root,
 * when a relative path tries to climb out of the URL template, or when an
 * absolute path arrives with no `apiRoot` configured.
 */
export function resolveTelegramFilePath(input: {
  readonly filePath: string;
  readonly apiRoot: string | undefined;
  readonly allowedRoots: readonly string[];
}): ResolvedTelegramFile {
  const filePath = input.filePath.trim();
  if (filePath === '') {
    throw new ConfigurationError(
      'The Bot API server returned an empty file_path. There is no file to fetch and no safe ' +
        'default to invent; the server or the volume behind it is misconfigured.',
    );
  }

  if (isServerAbsolutePath(filePath)) {
    return { kind: 'local-path', path: resolveLocalPath(filePath, input) };
  }

  return { kind: 'remote-url', url: buildDownloadUrl(filePath, input.apiRoot) };
}

function resolveLocalPath(
  filePath: string,
  input: { readonly apiRoot: string | undefined; readonly allowedRoots: readonly string[] },
): string {
  // Normalised with the flavour that recognised it, so a POSIX server path stays
  // a POSIX path when the host is Windows. Running it through the host's
  // `resolve` would rewrite `/var/lib/...` as `C:\var\lib\...` and hand back
  // something that names a different file than the server meant.
  const flavour = posix.isAbsolute(filePath) ? posix : win32;
  const normalized = flavour.normalize(filePath);

  // `..` is not rejected on sight: containment is the rule, and a path that
  // climbs and comes back is still inside. What is rejected is where it lands.
  if (!input.allowedRoots.some((root) => isPathInside(normalized, root))) {
    throw containmentFailure(normalized, input.allowedRoots);
  }

  if (input.apiRoot === undefined) {
    throw new ConfigurationError(
      `The Bot API server returned the absolute path "${redactToken(normalized)}", which only a ` +
        `local server does, but no API root is configured. Set TELEGRAM_API_ROOT and ` +
        `TELEGRAM_LOCAL_MODE=true to match the server actually in use — this is an infrastructure ` +
        `mismatch, not a user error.`,
    );
  }

  return normalized;
}

/**
 * Build the token-free download URL for a relative `file_path`.
 *
 * `..` is refused here rather than normalised away. The template puts the token
 * in a path segment, so a `file_path` of `../../bot<token>/sendMessage` would not
 * merely escape the file directory — it would aim the credential at a different
 * endpoint. Nothing legitimate needs it.
 */
function buildDownloadUrl(filePath: string, apiRoot: string | undefined): string {
  const segments = filePath.split(/[/\\]/).filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new ConfigurationError(
      `The Bot API server returned the file_path "${filePath}", which climbs out of the download ` +
        `directory. Refusing to build a URL from it.`,
    );
  }

  const root = (apiRoot ?? PUBLIC_BOT_API_ROOT).replace(/\/+$/, '');
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `${root}/file/bot${BOT_TOKEN_PLACEHOLDER}/${encoded}`;
}

/**
 * Put the real token into a URL from {@link resolveTelegramFilePath}.
 *
 * Exists so the substitution happens in one auditable place instead of by string
 * concatenation at each call site. Its result is a credential: pass it to the
 * HTTP client and let it go. Never log it, never store it, never put it in an
 * error.
 */
export function withBotToken(url: string, botToken: string): string {
  if (!url.includes(BOT_TOKEN_PLACEHOLDER)) {
    throw new ConfigurationError(
      'Expected a URL containing the bot-token placeholder. Applying a token to anything else ' +
        'risks appending it to a URL that already carries one.',
    );
  }
  return url.replace(BOT_TOKEN_PLACEHOLDER, botToken);
}
