import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPathInside } from './path-safety.js';

// Resolved against the current drive/root so the expectations hold on both
// POSIX and Windows.
const parent = resolve('/srv/tgtools/workspace/job-1');

describe('isPathInside', () => {
  it('treats a path as inside itself', () => {
    expect(isPathInside(parent, parent)).toBe(true);
  });

  it('treats an unnormalised spelling of the same path as inside', () => {
    expect(isPathInside(join(parent, '.', 'sub', '..'), parent)).toBe(true);
  });

  it('accepts a direct child', () => {
    expect(isPathInside(join(parent, 'video.mp4'), parent)).toBe(true);
  });

  it('accepts a deeply nested descendant', () => {
    expect(isPathInside(join(parent, 'a', 'b', 'c', 'thumb.jpg'), parent)).toBe(true);
  });

  it('rejects a sibling that merely shares a name prefix', () => {
    const sharedPrefixParent = resolve('/a/foo');

    expect(isPathInside(resolve('/a/foobar'), sharedPrefixParent)).toBe(false);
  });

  it('rejects a sibling directory tree with a shared prefix', () => {
    const sharedPrefixParent = resolve('/a/foo');

    expect(isPathInside(resolve('/a/foobar/inner/file.txt'), sharedPrefixParent)).toBe(false);
  });

  it('rejects a path that climbs out with ..', () => {
    expect(isPathInside(join(parent, '..', 'job-2', 'video.mp4'), parent)).toBe(false);
  });

  it('rejects the parent directory of the workspace', () => {
    expect(isPathInside(join(parent, '..'), parent)).toBe(false);
  });

  it('rejects an unrelated absolute path', () => {
    expect(isPathInside(resolve('/etc/passwd'), parent)).toBe(false);
  });
});
