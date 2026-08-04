import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogContext, Logger } from '@tgtools/shared';
import { MediaPlatform, createNoopLogger } from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCookieProvider, reportCookieAccess } from './file-cookie-provider.js';

interface Line {
  readonly level: 'warn' | 'error';
  readonly message: string;
  readonly context: LogContext | undefined;
}

/** Records the two levels this class is allowed to emit; ignores the rest. */
function createRecordingLogger(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const base = createNoopLogger();
  const logger: Logger = {
    ...base,
    warn: (message, context) => lines.push({ level: 'warn', message, context }),
    error: (message, context) => lines.push({ level: 'error', message, context }),
    child: () => logger,
  };
  return { logger, lines };
}

describe('a configured cookie file that cannot be read', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tgtools-cookies-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('says nothing at all when no path is configured', async () => {
    // The common case. A bot with no cookies mounted must not log on every job.
    const { logger, lines } = createRecordingLogger();
    const provider = new FileCookieProvider({ paths: {}, logger });

    await expect(provider.getCookies(MediaPlatform.YouTube)).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('logs at ERROR, not warn, when the path is set but the file is missing', async () => {
    // This is the case that cost a day of debugging: YOUTUBE_COOKIES_PATH was
    // set, the file was unreadable, and a `warn` scrolled past unnoticed while
    // every single request went out unauthenticated. An operator who configured
    // a credential and did not get one has a broken deployment, not a warning.
    const { logger, lines } = createRecordingLogger();
    const provider = new FileCookieProvider({
      paths: { [MediaPlatform.YouTube]: join(dir, 'absent.txt') },
      logger,
    });

    await expect(provider.getCookies(MediaPlatform.YouTube)).resolves.toBeUndefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('error');
    expect(lines[0]?.message).toContain('UNAUTHENTICATED');
    expect(String(lines[0]?.context?.hint)).toContain('INSIDE the container');
  });

  it('names the uid when the file exists but the permissions hide it', async () => {
    // Root-owned 0600 inside a container that runs as uid 1001. The message has
    // to name `chown 1001:1001`, because "EACCES" alone does not tell an
    // operator which of the two sides is wrong.
    const path = join(dir, 'cookies.txt');
    await writeFile(path, '# Netscape HTTP Cookie File\n', 'utf8');
    await chmod(path, 0o000);

    const { logger, lines } = createRecordingLogger();
    const provider = new FileCookieProvider({
      paths: { [MediaPlatform.YouTube]: path },
      logger,
    });

    const cookies = await provider.getCookies(MediaPlatform.YouTube);

    // Windows and root ignore a 0o000 mode, so the read succeeds there. Assert
    // the hint only when the OS actually enforced the denial — a test that
    // passes for the wrong reason on CI is worse than one that skips.
    if (cookies === undefined && lines.length > 0) {
      expect(lines[0]?.level).toBe('error');
      expect(String(lines[0]?.context?.hint)).toContain('chown 1001:1001');
    } else {
      expect(cookies).toContain('Netscape');
    }
  });

  it('never leaks cookie content into the log context', async () => {
    // The log line carries the path and a hint. It must never carry the jar.
    const path = join(dir, 'cookies.txt');
    await writeFile(path, 'not-netscape-at-all sessionid=SECRETVALUE\n', 'utf8');

    const { logger, lines } = createRecordingLogger();
    const provider = new FileCookieProvider({ paths: { [MediaPlatform.YouTube]: path }, logger });

    await expect(provider.getCookies(MediaPlatform.YouTube)).resolves.toBeUndefined();

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('SECRETVALUE');
  });

  it('still degrades to anonymous access rather than failing the job', async () => {
    // Loud in the log, but the download must still be attempted: a public video
    // does not need cookies, and failing it would make things strictly worse.
    const { logger } = createRecordingLogger();
    const provider = new FileCookieProvider({
      paths: { [MediaPlatform.YouTube]: join(dir, 'absent.txt') },
      logger,
    });

    await expect(provider.getCookies(MediaPlatform.YouTube)).resolves.toBeUndefined();
  });
});

/**
 * The startup check. Its whole reason to exist: the bot and the worker are
 * separate containers with separate mounts, and a user's first sign that they
 * disagree was a video that listed every quality and then refused to download.
 */
describe('reportCookieAccess', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tgtools-cookie-report-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports nothing and logs nothing when no cookies are configured', async () => {
    const { logger, lines } = createRecordingLogger();
    await expect(reportCookieAccess({}, logger)).resolves.toEqual([]);
    expect(lines).toEqual([]);
  });

  it('passes a good file silently', async () => {
    const path = join(dir, 'ok.txt');
    await writeFile(path, '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\ta\tb\n');

    const { logger, lines } = createRecordingLogger();
    const reports = await reportCookieAccess({ [MediaPlatform.YouTube]: path }, logger);

    expect(reports).toEqual([{ platform: MediaPlatform.YouTube, kind: 'usable' }]);
    expect(lines).toEqual([]);
  });

  it('reports a file this container cannot reach, and says the two can differ', async () => {
    const { logger, lines } = createRecordingLogger();
    const reports = await reportCookieAccess(
      { [MediaPlatform.YouTube]: join(dir, 'absent.txt') },
      logger,
    );

    expect(reports[0]?.kind).toBe('unreadable');
    expect(lines[0]?.level).toBe('error');
    // The sentence that would have saved an evening.
    expect(lines[0]?.message).toContain('one working does not mean both do');
  });

  it('catches a JSON export, which yt-dlp rejects with a confusing parse error', async () => {
    const path = join(dir, 'cookies.json');
    await writeFile(path, '[{"name":"SID","value":"x"}]');

    const { logger, lines } = createRecordingLogger();
    const reports = await reportCookieAccess({ [MediaPlatform.YouTube]: path }, logger);

    expect(reports[0]?.kind).toBe('wrong-format');
    expect(lines[0]?.level).toBe('error');
  });

  it('treats an empty file as degraded rather than broken', async () => {
    // `touch cookies.txt` is how a placeholder mount is usually created.
    const path = join(dir, 'empty.txt');
    await writeFile(path, '');

    const { logger, lines } = createRecordingLogger();
    const reports = await reportCookieAccess({ [MediaPlatform.YouTube]: path }, logger);

    expect(reports[0]?.kind).toBe('empty');
    expect(lines[0]?.level).toBe('warn');
  });

  it('checks every configured platform, not just the first that fails', async () => {
    const good = join(dir, 'good.txt');
    await writeFile(good, '# Netscape HTTP Cookie File\n');

    const { logger } = createRecordingLogger();
    const reports = await reportCookieAccess(
      { [MediaPlatform.YouTube]: join(dir, 'missing.txt'), [MediaPlatform.Instagram]: good },
      logger,
    );

    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.kind).sort()).toEqual(['unreadable', 'usable']);
  });

  it('never puts cookie content in the log', async () => {
    const path = join(dir, 'cookies.json');
    await writeFile(path, '[{"name":"SID","value":"SECRETVALUE"}]');

    const { logger, lines } = createRecordingLogger();
    await reportCookieAccess({ [MediaPlatform.YouTube]: path }, logger);

    expect(JSON.stringify(lines)).not.toContain('SECRETVALUE');
  });
});
