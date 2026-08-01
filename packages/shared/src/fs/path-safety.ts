import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute, sep } from 'node:path';

/**
 * True when `candidate` resolves to `parent` itself or something beneath it.
 * Purely lexical — see {@link assertContainedPath} for the check that also
 * refuses a symlink pointing out of the tree.
 */
export function isPathInside(candidate: string, parent: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedParent) return true;
  const rel = relative(resolvedParent, resolvedCandidate);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`);
}

export class PathEscapeError extends Error {
  constructor(candidate: string, parent: string) {
    super(`Refusing to touch "${candidate}": it resolves outside "${parent}".`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Refuse a path that leaves its workspace, following symlinks before deciding.
 *
 * yt-dlp writes files whose names come from a remote title, and post-processors
 * add siblings we did not name. Resolving the real path first is what stops a
 * planted symlink from turning "delete the job directory" into "delete
 * something else".
 */
export async function assertContainedPath(candidate: string, parent: string): Promise<string> {
  const realParent = await realpath(parent);
  // `realpath` on the candidate would fail for a not-yet-created file, so only
  // resolve links when something is actually there.
  let realCandidate = resolve(candidate);
  try {
    const stats = await lstat(realCandidate);
    if (stats.isSymbolicLink() || stats.isDirectory() || stats.isFile()) {
      realCandidate = await realpath(realCandidate);
    }
  } catch {
    // Not on disk yet: the lexical check below is all we can do, and all we need.
  }
  if (!isPathInside(realCandidate, realParent)) throw new PathEscapeError(candidate, parent);
  return realCandidate;
}
