import { access, constants } from 'node:fs/promises';
import { runProcess } from '@tgtools/file-tools-engine';
import type { Logger } from '@tgtools/shared';

/**
 * Confirm every native dependency is actually present and usable.
 *
 * Run once at startup rather than on the first job. The whole point of this
 * process is the binaries it shells out to, and a container missing `pdftocairo`
 * looks perfectly healthy right up until a user sends a PDF — at which point the
 * failure is a confusing ENOENT in one job's log rather than an obvious startup
 * error in the deployment's.
 *
 * Deliberately NOT part of the periodic health endpoint: these are version
 * probes that fork processes, and running them every ten seconds would spend
 * more CPU on checking than on working.
 */

export interface ToolchainReport {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function probeBinary(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<ToolchainReport> {
  try {
    const result = await runProcess({ command, args, cwd, timeoutMs: 10_000 });
    // `ffmpeg -version` exits 0; `pdfinfo -v` writes to stderr and exits 99 on
    // some builds. Presence of output is the honest signal, not the code.
    const output = `${result.stdout}${result.stderr}`.trim();
    if (output === '') {
      return { name: command, ok: false, detail: 'produced no output' };
    }
    return { name: command, ok: true, detail: output.split(/\r?\n/)[0] ?? '' };
  } catch (error: unknown) {
    return {
      name: command,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ToolchainProbeOptions {
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly workspaceDir: string;
  readonly cwd: string;
}

export async function probeToolchain(
  options: ToolchainProbeOptions,
): Promise<readonly ToolchainReport[]> {
  const reports: ToolchainReport[] = [];

  reports.push(await probeBinary(options.ffmpegPath, ['-version'], options.cwd));
  reports.push(await probeBinary(options.ffprobePath, ['-version'], options.cwd));
  reports.push(await probeBinary('pdftocairo', ['-v'], options.cwd));
  reports.push(await probeBinary('pdfinfo', ['-v'], options.cwd));

  // The encoder, not just the binary. An FFmpeg built without libmp3lame runs
  // fine and then fails every single "video to MP3" job with an error about an
  // unknown encoder — which reads as a bug in this code rather than a gap in
  // the image.
  reports.push(await probeMp3Encoder(options.ffmpegPath, options.cwd));

  // Sharp is loaded, not merely imported: its native binding is resolved
  // lazily, and a musl/glibc mismatch only surfaces on first use.
  reports.push(await probeSharp());

  reports.push(await probeWritable(options.workspaceDir));

  return reports;
}

async function probeMp3Encoder(ffmpegPath: string, cwd: string): Promise<ToolchainReport> {
  const name = 'libmp3lame';
  try {
    const result = await runProcess({
      command: ffmpegPath,
      args: ['-hide_banner', '-encoders'],
      cwd,
      timeoutMs: 10_000,
      maxOutputBytes: 512 * 1024,
    });
    const present = result.stdout.includes('libmp3lame');
    return {
      name,
      ok: present,
      detail: present ? 'available' : 'NOT built into this ffmpeg',
    };
  } catch (error: unknown) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeSharp(): Promise<ToolchainReport> {
  try {
    const sharp = (await import('sharp')).default;
    // A one-pixel encode, which exercises the native path end to end. Reading
    // `sharp.versions` alone would pass on a build whose binding cannot run.
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000000' } })
      .jpeg()
      .toBuffer();
    return { name: 'sharp', ok: true, detail: `libvips ${sharp.versions.vips ?? 'unknown'}` };
  } catch (error: unknown) {
    return {
      name: 'sharp',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeWritable(directory: string): Promise<ToolchainReport> {
  try {
    await access(directory, constants.W_OK);
    return { name: 'workspace', ok: true, detail: directory };
  } catch (error: unknown) {
    return {
      name: 'workspace',
      ok: false,
      detail: `${directory} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Report the probe, and say whether the process should refuse to start.
 *
 * A missing binary is fatal rather than a warning: unlike a cookie file, there
 * is no degraded mode. Half the tools would accept work and fail every job,
 * which is worse than not accepting it.
 */
export function summariseToolchain(reports: readonly ToolchainReport[], logger: Logger): boolean {
  for (const report of reports) {
    if (report.ok) logger.info('toolchain', { component: report.name, detail: report.detail });
    else
      logger.error('toolchain component unusable', {
        component: report.name,
        detail: report.detail,
      });
  }
  return reports.every((report) => report.ok);
}
