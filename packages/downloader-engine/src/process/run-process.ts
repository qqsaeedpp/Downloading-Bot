import { execFile } from 'node:child_process';
import type { Logger } from '@tgtools/shared';
import { createAbortScope, toAbortError } from '@tgtools/shared';

export interface RunProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly label: string;
  readonly logger: Logger;
  readonly maxBufferBytes?: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class ProcessFailedError extends Error {
  constructor(
    readonly label: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    options: { cause?: unknown } = {},
  ) {
    super(`${label} failed with exit code ${String(exitCode)}`, options);
    this.name = 'ProcessFailedError';
  }
}

/**
 * Run an external binary with an argument array and a hard deadline.
 *
 * `execFile`, never `exec`: the latter hands the string to `/bin/sh`, and every
 * argument here — file paths derived from remote titles, filter expressions
 * containing commas and colons — is exactly the kind of input that turns a
 * shell into a remote code execution primitive.
 */
export async function runProcess(options: RunProcessOptions): Promise<ProcessResult> {
  const scope = createAbortScope({
    parent: options.signal,
    timeoutMs: options.timeoutMs,
    label: options.label,
  });

  try {
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = execFile(
        options.executable,
        [...options.args],
        {
          // FFmpeg is chatty on stderr and ffprobe's JSON can be large; a small
          // buffer turns a successful run into a spurious ENOBUFS failure.
          maxBuffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
          signal: scope.signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr });
            return;
          }
          // A killed child reports as a generic failure; the abort reason says
          // whether that was a timeout or a cancellation, which the caller
          // needs in order to pick the right message.
          if (scope.signal.aborted) {
            reject(toAbortError(scope.signal.reason));
            return;
          }
          const exitCode = typeof error.code === 'number' ? error.code : null;
          reject(new ProcessFailedError(options.label, exitCode, stderr, { cause: error }));
        },
      );

      child.on('error', (error) => {
        reject(new ProcessFailedError(options.label, null, '', { cause: error }));
      });
    });
  } finally {
    scope.dispose();
  }
}
