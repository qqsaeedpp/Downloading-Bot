import { ConfigurationError } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import {
  BOT_TOKEN_PLACEHOLDER,
  PUBLIC_BOT_API_ROOT,
  resolveTelegramFilePath,
  withBotToken,
} from './local-file-resolver.js';

const API_ROOT = 'http://telegram-bot-api:8081';
const ALLOWED_ROOTS = ['/data/downloads'] as const;

// A real token, only so the assertions about leaking one are meaningful.
const BOT_TOKEN = '7000000000:AAF-this-is-shaped-like-a-real-token';

/** Paths are written POSIX-style throughout: they belong to the Bot API server's
 * filesystem — a Linux container — not to whatever host runs the test. */
function resolveLocal(filePath: string, allowedRoots: readonly string[] = ALLOWED_ROOTS) {
  return resolveTelegramFilePath({ filePath, apiRoot: API_ROOT, allowedRoots });
}

describe('resolveTelegramFilePath', () => {
  describe('a local server answers with an absolute path', () => {
    it('reports it as a file to open rather than a URL to fetch', () => {
      // The whole point of the module. A local Bot API server puts the file on a
      // volume we already have mounted; downloading it back over HTTP would be
      // pointless even if the URL worked, and the URL does not work.
      expect(resolveLocal('/data/downloads/videos/file_12.mp4')).toEqual({
        kind: 'local-path',
        path: '/data/downloads/videos/file_12.mp4',
      });
    });

    it('never produces a URL carrying the server path, however deep the path', () => {
      const resolved = resolveLocal('/data/downloads/music/file_9.mp3');

      expect(resolved.kind).toBe('local-path');
      // Guards the specific regression: concatenating an absolute path onto the
      // template yields `.../file/bot<token>//data/downloads/...`, which puts the
      // server's directory layout into every log line that carries the URL.
      expect(JSON.stringify(resolved)).not.toContain('/file/bot');
      expect(JSON.stringify(resolved)).not.toContain('http');
    });

    it('accepts the allowed root itself', () => {
      expect(resolveLocal('/data/downloads')).toEqual({
        kind: 'local-path',
        path: '/data/downloads',
      });
    });

    it('normalises a redundant spelling instead of rejecting it', () => {
      // Containment is the rule, not spelling: this lands inside the root.
      expect(resolveLocal('/data/downloads/./videos/../videos/file_1.mp4')).toEqual({
        kind: 'local-path',
        path: '/data/downloads/videos/file_1.mp4',
      });
    });

    it('searches every configured root, not just the first', () => {
      const resolved = resolveTelegramFilePath({
        filePath: '/srv/telegram/file_3.mp4',
        apiRoot: API_ROOT,
        allowedRoots: ['/data/downloads', '/srv/telegram'],
      });

      expect(resolved).toEqual({ kind: 'local-path', path: '/srv/telegram/file_3.mp4' });
    });
  });

  describe('containment', () => {
    it('rejects a sibling that merely shares a string prefix with the root', () => {
      // `startsWith` containment would pass this. `/data/downloads-evil` is not
      // inside `/data/downloads`, and a volume an attacker can create next to
      // ours is exactly how that mistake gets exploited.
      expect(() => resolveLocal('/data/downloads-evil/file_1.mp4')).toThrow(ConfigurationError);
      expect(() => resolveLocal('/data/downloads-evil/file_1.mp4')).toThrow(
        /outside every directory/,
      );
    });

    it('rejects a root-prefixed sibling even with no path after it', () => {
      expect(() => resolveLocal('/data/downloads-evil')).toThrow(ConfigurationError);
    });

    it('rejects a path that climbs out of the root with ..', () => {
      expect(() => resolveLocal('/data/downloads/../../etc/passwd')).toThrow(ConfigurationError);
    });

    it('rejects a path that climbs exactly one level out', () => {
      expect(() => resolveLocal('/data/downloads/..')).toThrow(ConfigurationError);
    });

    it('rejects an unrelated absolute path', () => {
      expect(() => resolveLocal('/etc/shadow')).toThrow(ConfigurationError);
    });

    it('rejects everything when no root is configured', () => {
      // Fail closed. An empty root list means nobody said what we may read, which
      // is not the same as permission to read anything.
      expect(() => resolveLocal('/data/downloads/file_1.mp4', [])).toThrow(ConfigurationError);
    });

    it('names the failure as a deployment problem and lists the roots', () => {
      // The operator reading this line is the one who can fix it; a user cannot
      // cause it and must never be shown it.
      let message = '';
      try {
        resolveLocal('/etc/shadow');
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('deployment problem');
      expect(message).toContain('/data/downloads');
    });

    it('keeps the token out of the rejection message', () => {
      // The local server stores files under a directory named after the token,
      // so the offending path in a containment failure routinely contains one.
      // An error that quotes it verbatim ships the credential to the log
      // aggregator.
      let message = '';
      try {
        resolveLocal(`/var/lib/telegram-bot-api/${BOT_TOKEN}/videos/file_1.mp4`);
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).not.toContain(BOT_TOKEN);
      expect(message).toContain(BOT_TOKEN_PLACEHOLDER);
    });
  });

  describe('the public API answers with a relative path', () => {
    it('builds the standard download URL under the configured API root', () => {
      expect(
        resolveTelegramFilePath({
          filePath: 'videos/file_12.mp4',
          apiRoot: API_ROOT,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toEqual({
        kind: 'remote-url',
        url: `${API_ROOT}/file/bot${BOT_TOKEN_PLACEHOLDER}/videos/file_12.mp4`,
      });
    });

    it('falls back to the public Bot API root when none is configured', () => {
      expect(
        resolveTelegramFilePath({
          filePath: 'videos/file_12.mp4',
          apiRoot: undefined,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toEqual({
        kind: 'remote-url',
        url: `${PUBLIC_BOT_API_ROOT}/file/bot${BOT_TOKEN_PLACEHOLDER}/videos/file_12.mp4`,
      });
    });

    it('does not double the separator when the API root has a trailing slash', () => {
      const resolved = resolveTelegramFilePath({
        filePath: 'videos/file_12.mp4',
        apiRoot: `${API_ROOT}/`,
        allowedRoots: ALLOWED_ROOTS,
      });

      expect(resolved).toEqual({
        kind: 'remote-url',
        url: `${API_ROOT}/file/bot${BOT_TOKEN_PLACEHOLDER}/videos/file_12.mp4`,
      });
    });

    it('percent-encodes each segment without encoding the separators', () => {
      // A `file_path` is server-supplied text. Left raw, a `?` or a `#` in it
      // truncates the URL and the request fetches something else.
      const resolved = resolveTelegramFilePath({
        filePath: 'videos/a b?c#d.mp4',
        apiRoot: API_ROOT,
        allowedRoots: ALLOWED_ROOTS,
      });

      expect(resolved).toEqual({
        kind: 'remote-url',
        url: `${API_ROOT}/file/bot${BOT_TOKEN_PLACEHOLDER}/videos/a%20b%3Fc%23d.mp4`,
      });
    });

    it('refuses a relative path that climbs out of the download directory', () => {
      // The token sits in a path segment of the template, so climbing does not
      // merely escape the file directory — `../../bot<token>/sendMessage` would
      // aim the credential at a different endpoint.
      expect(() =>
        resolveTelegramFilePath({
          filePath: '../../bot123/sendMessage',
          apiRoot: API_ROOT,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toThrow(ConfigurationError);
      expect(() =>
        resolveTelegramFilePath({
          filePath: 'videos/../../secrets/file_1.mp4',
          apiRoot: API_ROOT,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toThrow(/climbs out of the download directory/);
    });
  });

  describe('credentials', () => {
    it('never returns anything token-shaped, because it is never given a token', () => {
      // The function signature has no token parameter and this asserts the
      // consequence: every value it returns is safe to log or to attach to a job.
      const resolved = resolveTelegramFilePath({
        filePath: 'videos/file_12.mp4',
        apiRoot: API_ROOT,
        allowedRoots: ALLOWED_ROOTS,
      });

      expect(JSON.stringify(resolved)).not.toMatch(/\d{6,}:[A-Za-z0-9_-]{20,}/);
      expect(resolved).toEqual({
        kind: 'remote-url',
        url: expect.stringContaining(BOT_TOKEN_PLACEHOLDER),
      });
    });

    it('substitutes the token only where the caller asks for it', () => {
      const resolved = resolveTelegramFilePath({
        filePath: 'videos/file_12.mp4',
        apiRoot: API_ROOT,
        allowedRoots: ALLOWED_ROOTS,
      });
      const url = resolved.kind === 'remote-url' ? resolved.url : '';

      expect(withBotToken(url, BOT_TOKEN)).toBe(
        `${API_ROOT}/file/bot${BOT_TOKEN}/videos/file_12.mp4`,
      );
    });

    it('refuses to apply a token to a URL with no placeholder', () => {
      // Guards against a second application, which would append the token to a
      // URL that already carries one and produce a 404 nobody can explain.
      expect(() => withBotToken(`${API_ROOT}/file/bot${BOT_TOKEN}/x.mp4`, BOT_TOKEN)).toThrow(
        ConfigurationError,
      );
    });
  });

  describe('misconfiguration', () => {
    it('refuses an absolute path when no API root is configured', () => {
      // Only a local server answers with an absolute path. Receiving one while
      // configured for the public API means the deployment and the configuration
      // disagree, and continuing would mean guessing which is right.
      expect(() =>
        resolveTelegramFilePath({
          filePath: '/data/downloads/videos/file_12.mp4',
          apiRoot: undefined,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toThrow(/TELEGRAM_API_ROOT/);
    });

    it('rejects an empty or blank file_path rather than inventing a default', () => {
      expect(() => resolveLocal('')).toThrow(ConfigurationError);
      expect(() => resolveLocal('   ')).toThrow(/empty file_path/);
    });

    it('treats a Windows-rooted path as absolute even on a POSIX host', () => {
      // `node:path` follows the host's rules, and the host is not the API server.
      // A path the host would call relative gets spliced into a public URL, which
      // is the leak this module exists to prevent — so both flavours are checked.
      expect(() =>
        resolveTelegramFilePath({
          filePath: 'C:\\Windows\\System32\\config\\SAM',
          apiRoot: API_ROOT,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toThrow(ConfigurationError);
    });

    it('treats a UNC path as absolute even on a POSIX host', () => {
      expect(() =>
        resolveTelegramFilePath({
          filePath: '\\\\attacker-host\\share\\file_1.mp4',
          apiRoot: API_ROOT,
          allowedRoots: ALLOWED_ROOTS,
        }),
      ).toThrow(ConfigurationError);
    });
  });
});
