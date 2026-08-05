import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolErrorCode, isToolError } from '../errors/tool-error.js';
import { ToolWorkspaceManager } from './tool-workspace.js';

describe('ToolWorkspaceManager', () => {
  let root: string;
  let manager: ToolWorkspaceManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tgtools-ws-'));
    manager = new ToolWorkspaceManager({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a relative root, which would resolve against the process cwd', () => {
    expect(() => new ToolWorkspaceManager({ rootDir: 'relative/tools' })).toThrow(/absolute/);
  });

  it('gives each job three isolated areas', async () => {
    const ws = await manager.create('job-1');
    const entries = await readdir(ws.root);
    expect(entries.sort()).toEqual(['input', 'output', 'temp']);
  });

  it('never builds a path from a caller-supplied name', async () => {
    // Every filename here began in a Telegram message. Names are generated; the
    // user's own filename survives only as metadata.
    const ws = await manager.create('job-1');
    const a = ws.path('output', 'jpg');
    const b = ws.path('output', 'jpg');

    expect(a).not.toBe(b);
    expect(a.endsWith('.jpg')).toBe(true);
    expect(a.startsWith(ws.outputDir + sep)).toBe(true);
  });

  it('rejects an extension carrying path syntax', async () => {
    // The extension is often derived from a user-supplied filename, so it is
    // the one part of a generated name that is still attacker-influenced.
    const ws = await manager.create('job-1');
    for (const bad of ['../../etc', 'jp/g', 'jp\\g', '', 'a'.repeat(20), '.jpg', 'jpg;rm']) {
      expect(() => ws.path('output', bad), bad).toThrow();
    }
  });

  it('rejects a job id that is not a safe directory name', async () => {
    for (const bad of ['../escape', 'a/b', '', 'a'.repeat(100), 'a b']) {
      await expect(manager.create(bad), bad).rejects.toThrow();
    }
  });

  it('refuses a path that escapes the workspace', async () => {
    const ws = await manager.create('job-1');
    for (const outside of [
      join(root, 'job-2', 'x.jpg'),
      join(root, '..', 'x.jpg'),
      '/etc/passwd',
    ]) {
      expect(() => ws.assertInside(outside), outside).toThrow();
    }
    expect(() => ws.assertInside(join(ws.outputDir, 'ok.jpg'))).not.toThrow();
  });

  it('does not mistake a sibling with a shared prefix for a child', async () => {
    // The classic off-by-one in containment checks: `/data/tools/ab` starts
    // with `/data/tools/a` as a string, but is not inside it.
    const ws = await manager.create('job-1');
    expect(() => ws.assertInside(`${ws.root}-sibling/file.jpg`)).toThrow();
  });

  it('removes the workspace even when the work throws', async () => {
    // The path that gets forgotten when disposal is left to the caller is
    // always the error path, which is why `with` exists.
    await expect(
      manager.with('job-err', async (ws) => {
        await writeFile(ws.path('temp', 'bin'), 'x');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await readdir(root)).toEqual([]);
  });

  it('removes the workspace on success too', async () => {
    const result = await manager.with('job-ok', async (ws) => {
      await writeFile(ws.path('output', 'txt'), 'x');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await readdir(root)).toEqual([]);
  });

  it('tolerates being disposed twice', async () => {
    const ws = await manager.create('job-1');
    await ws.dispose();
    await expect(ws.dispose()).resolves.toBeUndefined();
  });
});

describe('sweepOrphans', () => {
  let root: string;
  let manager: ToolWorkspaceManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tgtools-sweep-'));
    manager = new ToolWorkspaceManager({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes a stale workspace and keeps a fresh one', async () => {
    await manager.create('old-job');
    await manager.create('new-job');

    // Only `old-job` is older than the age given, because `now` is moved
    // forward rather than the directory's mtime being faked.
    const removed = await manager.sweepOrphans(60_000, Date.now() + 120_000);
    expect(removed).toContain('old-job');

    const survivorsAfterFreshSweep = await manager.sweepOrphans(60_000, Date.now());
    expect(survivorsAfterFreshSweep).toEqual([]);
  });

  it('ignores entries whose names are not job ids', async () => {
    // A sweep that deleted whatever it found would be one misconfigured path
    // away from removing something that matters.
    await writeFile(join(root, 'README.md'), 'keep me');
    const removed = await manager.sweepOrphans(0, Date.now() + 1_000);
    expect(removed).not.toContain('README.md');
    expect(await readdir(root)).toContain('README.md');
  });

  it('returns nothing rather than throwing when the root does not exist', async () => {
    const missing = new ToolWorkspaceManager({ rootDir: join(root, 'absent') });
    await expect(missing.sweepOrphans(0)).resolves.toEqual([]);
  });
});

describe('disk space guard', () => {
  it('is silent when no minimum is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tgtools-disk-'));
    try {
      const manager = new ToolWorkspaceManager({ rootDir: root });
      await expect(manager.assertDiskSpace()).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a job when the volume is nearly full', async () => {
    // Checked BEFORE the work: running out of disk half way through leaves a
    // partial file and a confusing error.
    const root = await mkdtemp(join(tmpdir(), 'tgtools-disk-'));
    try {
      const manager = new ToolWorkspaceManager({
        rootDir: root,
        minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
      });

      await expect(manager.assertDiskSpace()).rejects.toSatisfy(
        (error: unknown) => isToolError(error) && error.code === ToolErrorCode.DiskSpaceLow,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
