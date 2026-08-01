import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Materialise cookie content into a temporary file for the length of one call,
 * then remove it.
 *
 * yt-dlp's `--cookies` wants a path, not a string, so a file has to exist at
 * some point. Keeping its lifetime to a single invocation — with `0600` on both
 * the file and its directory — is the difference between a session that is
 * briefly on disk and one that sits in `/tmp` until the next reboot.
 *
 * The file is written under the OS temp directory rather than the job
 * workspace, so a bug in workspace handling can never expose it, and so it is
 * not counted by the size watchdog.
 */
export async function withCookieFile<T>(
  cookies: string | undefined,
  run: (cookiePath: string | undefined) => Promise<T>,
): Promise<T> {
  if (cookies === undefined || cookies.trim() === '') return run(undefined);

  const directory = await mkdtemp(join(tmpdir(), 'tgtools-cookies-'));
  const cookiePath = join(directory, 'cookies.txt');
  try {
    await writeFile(cookiePath, cookies, { encoding: 'utf8', mode: 0o600 });
    return await run(cookiePath);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      // Nothing useful can be done about a failed unlink here, and throwing
      // would replace the caller's real error with a cleanup error.
    });
  }
}
