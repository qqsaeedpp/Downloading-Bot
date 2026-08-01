import { createNoopLogger } from '@tgtools/shared';
import { describe, expect, it, vi } from 'vitest';
import { YtDlpNodeRunner } from './ytdlp-node-runner.js';

const MISSING_FFMPEG = '/usr/bin/ffmpeg';

function createRunner(exec: ReturnType<typeof vi.fn>) {
  return new YtDlpNodeRunner({
    binaryPath: '/usr/local/bin/yt-dlp',
    // Exactly the production symptom: the bot image sets this path but never
    // installs the binary.
    ffmpegPath: MISSING_FFMPEG,
    logger: createNoopLogger(),
    execFileImpl: exec as unknown as YtDlpNodeRunnerExec,
  });
}

// `execFileImpl` is optional on the options object, so the derived type carries
// `| undefined`. Under `exactOptionalPropertyTypes` that is exactly what an
// optional property may NOT be assigned, hence the unwrap.
type YtDlpNodeRunnerExec = NonNullable<
  ConstructorParameters<typeof YtDlpNodeRunner>[0]['execFileImpl']
>;

describe('YtDlpNodeRunner.dumpJson', () => {
  it('inspects without touching FFmpeg', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{"id":"abc"}', stderr: '' });
    const runner = createRunner(exec);

    const result = await runner.dumpJson({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      args: ['--dump-single-json', '--skip-download'],
      signal: undefined,
    });

    expect(result.stdout).toBe('{"id":"abc"}');

    // The regression. Metadata extraction never decodes or muxes anything, so
    // requiring FFmpeg for it made the bot container fail on a dependency it
    // has no reason to carry.
    const [executable, args] = exec.mock.calls[0] as [string, string[]];
    expect(executable).toBe('/usr/local/bin/yt-dlp');
    expect(args).not.toContain('--ffmpeg-location');
    expect(args.join(' ')).not.toContain(MISSING_FFMPEG);
  });

  it('passes the URL after a `--` terminator so it can never be read as a flag', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    const runner = createRunner(exec);

    await runner.dumpJson({
      url: '-oh-no-a-flag',
      args: ['--dump-single-json'],
      signal: undefined,
    });

    const [, args] = exec.mock.calls[0] as [string, string[]];
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('-oh-no-a-flag');
  });

  it('spawns with an argument array and never a shell', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    const runner = createRunner(exec);

    await runner.dumpJson({ url: 'https://x.com/a/status/1', args: [], signal: undefined });

    const [, args, options] = exec.mock.calls[0] as [string, string[], { shell?: boolean }];
    expect(Array.isArray(args)).toBe(true);
    expect(options.shell).not.toBe(true);
  });

  it('forwards the caller signal so a cancelled inspection kills the process', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '{}', stderr: '' });
    const runner = createRunner(exec);
    const controller = new AbortController();

    await runner.dumpJson({
      url: 'https://x.com/a/status/1',
      args: [],
      signal: controller.signal,
    });

    const [, , options] = exec.mock.calls[0] as [string, string[], { signal?: AbortSignal }];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a failure as a process error carrying stderr for the mapper', async () => {
    const failure = Object.assign(new Error('Command failed'), {
      code: 1,
      stderr: 'ERROR: [twitter] 1: No video could be found in this tweet',
      stdout: '',
    });
    const exec = vi.fn().mockRejectedValue(failure);
    const runner = createRunner(exec);

    await expect(
      runner.dumpJson({ url: 'https://x.com/a/status/1', args: [], signal: undefined }),
    ).rejects.toMatchObject({
      name: 'YtDlpProcessError',
      stderr: expect.stringContaining('No video could be found'),
    });
  });
});
