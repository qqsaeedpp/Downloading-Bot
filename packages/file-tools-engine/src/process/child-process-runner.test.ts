import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolErrorCode, isToolError } from '../errors/tool-error.js';
import { runProcess, runProcessOrThrow } from './child-process-runner.js';

/** `process.execPath` is the one binary guaranteed to exist wherever this runs. */
const NODE = process.execPath;

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

describe('runProcess', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'tgtools-proc-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('captures stdout and stderr and reports the exit code', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('resolves on a non-zero exit rather than throwing', async () => {
    // What a non-zero code MEANS differs per tool — pdfinfo uses it for
    // "encrypted" — so the decision belongs to the caller.
    await expect(
      runProcess({ command: NODE, args: ['-e', 'process.exit(1)'], cwd, timeoutMs: 10_000 }),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it('never interprets its arguments as a shell command', async () => {
    // The property the whole module exists for. With `shell: true` this
    // argument would run `touch`; with an argument array it is just a string
    // that node prints back.
    const injected = 'hello; touch /tmp/tgtools-pwned';
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', injected],
      cwd,
      timeoutMs: 10_000,
    });

    expect(result.stdout).toBe(injected);
  });

  it('kills a process that outruns its timeout, and says so', async () => {
    const started = Date.now();
    await expect(
      runProcess({
        command: NODE,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd,
        timeoutMs: 250,
      }),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.ToolTimeout);

    // Proves it was actually killed rather than waited out.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('reports a cancellation as cancelled, not as a timeout', async () => {
    // The two produce the same dead process and mean opposite things: one is
    // the user's choice, the other is a failure worth investigating.
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 100);

    await expect(
      runProcess({
        command: NODE,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd,
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.ToolCancelled);
  });

  it('does not spawn anything when already cancelled', async () => {
    // A cancel that lands between queueing and starting should cost nothing.
    const controller = new AbortController();
    controller.abort();

    await expect(
      runProcess({
        command: NODE,
        args: ['-e', 'process.stdout.write("should not run")'],
        cwd,
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.ToolCancelled);
  });

  it('bounds captured output instead of growing without limit', async () => {
    // ffmpeg on a corrupt input can emit megabytes of repeated warnings.
    // Unbounded, one bad file becomes an out-of-memory kill of the worker.
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write("x".repeat(200000))'],
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 1_000,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(2_000);
    expect(result.stdout).toContain('truncated');
  });

  it('keeps the PREFIX when truncating, where the reason usually is', async () => {
    const result = await runProcess({
      command: NODE,
      args: ['-e', 'process.stderr.write("FATAL: bad input\\n" + "noise\\n".repeat(50000))'],
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 200,
    });

    expect(result.stderr.startsWith('FATAL: bad input')).toBe(true);
  });

  it('streams chunks to the progress callbacks', async () => {
    const seen: string[] = [];
    await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write("a");process.stdout.write("b")'],
      cwd,
      timeoutMs: 10_000,
      onStdout: (chunk) => seen.push(chunk),
    });

    expect(seen.join('')).toBe('ab');
  });

  it('reports a missing binary as a tool failure, not a crash', async () => {
    await expect(
      runProcess({
        command: join(cwd, 'definitely-not-a-binary'),
        args: [],
        cwd,
        timeoutMs: 5_000,
      }),
    ).rejects.toSatisfy((e: unknown) => codeOf(e) === ToolErrorCode.ExternalToolFailed);
  });
});

describe('runProcessOrThrow', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'tgtools-proc2-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('returns the result on success', async () => {
    await expect(
      runProcessOrThrow({
        command: NODE,
        args: ['-e', 'process.stdout.write("ok")'],
        cwd,
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
  });

  it('puts stderr in the error CONTEXT, never in the message', async () => {
    // The message can end up in a lot of places. Raw tool output belongs in the
    // structured log and nowhere near a user.
    let captured: unknown;
    try {
      await runProcessOrThrow({
        command: NODE,
        args: ['-e', 'process.stderr.write("libavcodec internal detail");process.exit(1)'],
        cwd,
        timeoutMs: 10_000,
      });
    } catch (error: unknown) {
      captured = error;
    }

    expect(codeOf(captured)).toBe(ToolErrorCode.ExternalToolFailed);
    expect(isToolError(captured) && captured.message).not.toContain('libavcodec');
    expect(isToolError(captured) && String(captured.context['stderr'])).toContain('libavcodec');
  });
});
