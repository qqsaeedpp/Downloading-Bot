import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceFactory, startSizeWatchdog } from '@tgtools/downloader-engine';
import type { WorkspaceFactory } from '@tgtools/downloader-engine';
import { createNoopLogger, delay, isPathInside } from '@tgtools/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Real filesystem, real directories. The workspace exists to survive concurrent
 * jobs, crashed workers and hostile filenames, and none of those can be
 * exercised against a mock.
 */
describe('job workspaces', () => {
  let root: string;
  let factory: WorkspaceFactory;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tgtools-ws-test-'));
    factory = createWorkspaceFactory({
      rootDirectory: root,
      logger: createNoopLogger(),
      minFreeBytes: 0,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('gives every job a directory of its own', async () => {
    const first = await factory.create('job-a');
    const second = await factory.create('job-b');

    // yt-dlp SKIPS an output whose file already exists and reports the stale
    // path, so a shared directory turns "give me 1080p" into "here is the 720p
    // someone else downloaded an hour ago".
    expect(first.directory).not.toBe(second.directory);
    expect(isPathInside(first.directory, root)).toBe(true);
  });

  it('builds an output template from the extractor id, never the title', async () => {
    const workspace = await factory.create('job-a');
    const template = workspace.createOutputTemplate();

    // A title is remote input: it can be four hundred characters of bidi
    // override marks, or `../../etc/passwd`.
    expect(template).toContain('%(id)');
    expect(template).not.toContain('%(title)');
    expect(isPathInside(template, workspace.directory)).toBe(true);
  });

  it('reports the total size of what it holds', async () => {
    const workspace = await factory.create('job-a');
    await writeFile(join(workspace.directory, 'a.part'), Buffer.alloc(4_096));
    await writeFile(join(workspace.directory, 'b.mp4'), Buffer.alloc(8_192));

    expect(await workspace.getSize()).toBe(12_288);
    expect(await workspace.listFiles()).toHaveLength(2);
  });

  it('survives being asked about a directory that has gone', async () => {
    const workspace = await factory.create('job-a');
    await rm(workspace.directory, { recursive: true, force: true });

    expect(await workspace.listFiles()).toEqual([]);
    expect(await workspace.getSize()).toBe(0);
  });

  it('cleans up, and does so idempotently', async () => {
    const workspace = await factory.create('job-a');
    await writeFile(join(workspace.directory, 'media.mp4'), Buffer.alloc(1_024));

    await workspace.cleanup();
    await expect(stat(workspace.directory)).rejects.toThrow();

    // Cleanup runs from success, failure, cancellation and shutdown paths, and
    // more than one of them can fire.
    await expect(workspace.cleanup()).resolves.toBeUndefined();
  });

  it('sweeps a directory left behind by a crashed worker', async () => {
    const orphan = await factory.create('job-dead');
    await writeFile(join(orphan.directory, 'partial.part'), Buffer.alloc(512));

    // Nothing is old enough yet.
    expect(await factory.removeOrphans(60_000)).toBe(0);
    // A zero-age cutoff is `Date.now()`, and a directory created microseconds
    // ago can carry exactly that mtime on a coarse filesystem clock — so give
    // it a moment rather than race the boundary.
    await delay(30);
    expect(await factory.removeOrphans(0)).toBe(1);
    expect(await readdir(root)).toHaveLength(0);
  });

  it('leaves unrelated directories alone when sweeping', async () => {
    await factory.create('job-a');
    const bystander = join(root, 'not-a-job');
    await mkdtemp(`${bystander}-`);

    await factory.removeOrphans(0);
    const remaining = await readdir(root);
    expect(remaining.some((entry) => entry.startsWith('not-a-job'))).toBe(true);
  });

  it('proves the download directory is writable', async () => {
    await expect(factory.ensureWritable()).resolves.toBeUndefined();
    expect(await readdir(root)).toHaveLength(0);
  });

  it('refuses to start a job when the disk is nearly full', async () => {
    const strict = createWorkspaceFactory({
      rootDirectory: root,
      logger: createNoopLogger(),
      // No real volume has an exabyte free.
      minFreeBytes: Number.MAX_SAFE_INTEGER,
    });
    // Losing the volume takes the container runtime with it, so a job that
    // cannot possibly fit is better declined up front.
    await expect(strict.create('job-a')).rejects.toMatchObject({
      code: 'INSUFFICIENT_STORAGE',
    });
  });
});

describe('the download size watchdog', () => {
  let root: string;
  let factory: WorkspaceFactory;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tgtools-wd-test-'));
    factory = createWorkspaceFactory({
      rootDirectory: root,
      logger: createNoopLogger(),
      minFreeBytes: 0,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('aborts a download that outgrows the ceiling while it runs', async () => {
    const workspace = await factory.create('job-a');
    let aborted: Error | undefined;

    const watchdog = startSizeWatchdog({
      workspace,
      maxBytes: 4_096,
      logger: createNoopLogger(),
      onExceeded: (error) => {
        aborted = error;
      },
      pollIntervalMs: 10,
    });

    // `--max-filesize` only fires when the extractor declared a size up front,
    // and Instagram, TikTok and every HLS stream declare nothing at all.
    await writeFile(join(workspace.directory, 'growing.part'), Buffer.alloc(16_384));
    await delay(80);
    watchdog.stop();

    expect(aborted?.message).toMatch(/ceiling/);
    expect(watchdog.peakBytes()).toBeGreaterThanOrEqual(16_384);
  });

  it('stays quiet while the download is within budget', async () => {
    const workspace = await factory.create('job-a');
    let aborted: Error | undefined;

    const watchdog = startSizeWatchdog({
      workspace,
      maxBytes: 1_000_000,
      logger: createNoopLogger(),
      onExceeded: (error) => {
        aborted = error;
      },
      pollIntervalMs: 10,
    });

    await writeFile(join(workspace.directory, 'fine.mp4'), Buffer.alloc(2_048));
    await delay(60);
    watchdog.stop();

    expect(aborted).toBeUndefined();
  });

  it('stops polling once it has been stopped', async () => {
    const workspace = await factory.create('job-a');
    let calls = 0;

    const watchdog = startSizeWatchdog({
      workspace,
      maxBytes: 1,
      logger: createNoopLogger(),
      onExceeded: () => {
        calls += 1;
      },
      pollIntervalMs: 10,
    });
    watchdog.stop();

    await writeFile(join(workspace.directory, 'big.part'), Buffer.alloc(8_192));
    await delay(60);
    expect(calls).toBe(0);
  });
});
