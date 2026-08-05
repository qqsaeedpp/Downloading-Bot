import { createWriteStream } from 'node:fs';
import { copyFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { InputKind, ToolWorkspace } from '@tgtools/file-tools-engine';
import {
  ToolError,
  ToolErrorCode,
  assertNotSymlinked,
  resolveInputKind,
  sniffFileType,
} from '@tgtools/file-tools-engine';
import type { Logger } from '@tgtools/shared';
import { describeError } from '@tgtools/shared';
import { resolveTelegramFilePath, withBotToken } from '@tgtools/telegram';
import type { ToolInputReference } from '@tgtools/tool-contracts';
import type { Api } from 'grammy';

/**
 * Getting a user's file out of Telegram and onto this worker's disk.
 *
 * The first thing in the codebase that DOWNLOADS from Telegram rather than
 * uploading to it, which is why `resolveTelegramFilePath` existed with tests and
 * no callers until now. Everything delicate about this module is in that
 * asymmetry: an upload hands Telegram a path we chose, and a download hands US a
 * path Telegram chose.
 *
 * Three separate guards, because they stop three different things:
 *
 *  1. `resolveTelegramFilePath` decides whether the answer is a path or a URL,
 *     and refuses a path that lands outside the configured roots. That is what
 *     stops a misconfigured — or compromised — Bot API server from naming
 *     `/etc/shadow`.
 *  2. `assertNotSymlinked` re-checks after resolution, because a symlink
 *     PLANTED INSIDE an allowed root passes step 1 and still points anywhere.
 *  3. The byte ceiling is enforced while streaming, not from the declared size.
 *     `file_size` is what the sending client said; the bytes are what arrive.
 */

export interface ToolFileFetcherOptions {
  readonly api: Api;
  readonly botToken: string;
  readonly apiRoot: string | undefined;
  readonly localFileRoots: readonly string[];
  readonly logger: Logger;
  /** How long one file may take to arrive. */
  readonly timeoutMs: number;
}

export interface FetchedFile {
  readonly path: string;
  readonly sizeBytes: number;
  /** The SNIFFED type. Never the declared one. */
  readonly mimeType: string;
  readonly kind: InputKind;
  /** The user's own filename, if their client sent one. Metadata only. */
  readonly originalName: string | undefined;
}

export class ToolFileFetcher {
  constructor(private readonly options: ToolFileFetcherOptions) {}

  /**
   * Fetch one input into the workspace and confirm it is what the tool needs.
   *
   * The type check happens HERE rather than in the processor because it must
   * happen after the bytes land and before anything else touches them: the
   * whole point is that Telegram's `mime_type` is the sending client's guess.
   */
  async fetch(input: {
    readonly reference: ToolInputReference;
    readonly workspace: ToolWorkspace;
    readonly expect: InputKind;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<FetchedFile> {
    const { reference, workspace, maxBytes } = input;

    // Refuse from the DECLARED size first, when there is one. It is not
    // trustworthy enough to accept a file on, but it is trustworthy enough to
    // reject one — and rejecting here costs no bandwidth at all.
    if (reference.declaredSize !== undefined && reference.declaredSize > maxBytes) {
      throw new ToolError(ToolErrorCode.InputTooLarge, 'declared file size is over the ceiling', {
        context: { declaredSize: reference.declaredSize, maxBytes },
      });
    }

    const file = await this.#getFile(reference.fileId);
    const filePath = file.file_path;
    if (filePath === undefined || filePath === '') {
      throw new ToolError(
        ToolErrorCode.TelegramFileUnavailable,
        'Telegram returned no file_path for this file',
      );
    }

    // The extension is only a hint for the workspace's generated name; it never
    // becomes part of a user-controlled path.
    const target = workspace.path('input', extensionHint(filePath, reference.originalName));

    const resolved = resolveTelegramFilePath({
      filePath,
      apiRoot: this.options.apiRoot,
      allowedRoots: this.options.localFileRoots,
    });

    if (resolved.kind === 'local-path') {
      await this.#copyLocal(resolved.path, target, maxBytes);
    } else {
      await this.#download(resolved.url, target, maxBytes, input.signal);
    }

    const { size } = await stat(target);
    if (size === 0) {
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'the fetched file was empty');
    }

    const sniffed = await sniffFileType(target);
    const kind = resolveInputKind({
      sniffedMimeType: sniffed,
      expected: input.expect,
      declaredMimeType: reference.declaredMimeType,
      declaredFileName: reference.originalName,
    });

    return {
      path: target,
      sizeBytes: size,
      mimeType: kind.mimeType,
      kind: kind.kind,
      originalName: reference.originalName,
    };
  }

  async #getFile(fileId: string): Promise<{ file_path?: string | undefined }> {
    try {
      return await this.options.api.getFile(fileId);
    } catch (error: unknown) {
      // Retryable: Telegram rate-limits `getFile` and briefly 500s under load.
      // A file id does not stop being valid because one call failed.
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'getFile failed', {
        cause: error,
        context: { reason: describeError(error) },
      });
    }
  }

  /**
   * The local Bot API case: the server wrote the file onto a volume we share.
   *
   * Copied rather than opened in place. The Bot API server deletes its copy
   * whenever it likes, and a processor reading straight from that directory
   * would race the deletion halfway through a transcode. It also keeps every
   * path a tool ever opens inside the job workspace, which is what makes the
   * workspace's containment check meaningful.
   */
  async #copyLocal(source: string, target: string, maxBytes: number): Promise<void> {
    const root = this.options.localFileRoots.find((candidate) => source.startsWith(candidate));
    if (root === undefined) {
      // `resolveTelegramFilePath` already established containment; this is
      // belt-and-braces for the symlink check below, which needs a root.
      throw new ToolError(ToolErrorCode.InternalError, 'resolved path has no owning root');
    }

    // A symlink planted INSIDE an allowed root passes containment and still
    // points wherever it likes. This is the check that catches that.
    await assertNotSymlinked(source, root);

    const info = await stat(source).catch((error: unknown) => {
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'the local file is not readable', {
        cause: error,
      });
    });

    if (info.size > maxBytes) {
      throw new ToolError(ToolErrorCode.InputTooLarge, 'file is larger than the ceiling', {
        context: { sizeBytes: info.size, maxBytes },
      });
    }

    await copyFile(source, target);
  }

  /**
   * The public API case: fetch over HTTPS.
   *
   * The URL carries the bot token in a path segment, so it is built at the last
   * possible moment and never logged, stored or attached to an error.
   */
  async #download(
    tokenlessUrl: string,
    target: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    // Either the user cancelling or the deadline expiring ends the fetch.
    const combined = AbortSignal.any([signal, timeout]);

    const response = await fetch(withBotToken(tokenlessUrl, this.options.botToken), {
      signal: combined,
    }).catch((error: unknown) => {
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'could not fetch the file', {
        cause: error,
      });
    });

    if (!response.ok) {
      // Deliberately only the status. The URL that produced it carries the
      // token, and an error object ends up in logs.
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'Telegram refused the download', {
        context: { status: response.status },
      });
    }

    const body = response.body;
    if (body === null) {
      throw new ToolError(ToolErrorCode.TelegramFileUnavailable, 'the response carried no body');
    }

    // Counted as it streams rather than trusted from Content-Length: a header
    // is a claim, and the ceiling exists to bound what actually lands on disk.
    let received = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new ToolError(ToolErrorCode.InputTooLarge, 'file exceeded the ceiling mid-stream', {
            context: { maxBytes },
          });
        }
        controller.enqueue(chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(body.pipeThrough(counter)),
      createWriteStream(target),
      // The signal stops the write too, so an aborted job does not keep filling
      // the volume after the user has stopped waiting.
      { signal: combined },
    );
  }
}

/**
 * A file extension for the workspace's generated name.
 *
 * Only ever a HINT: the workspace validates it, generates the actual filename,
 * and the real type is decided from the bytes afterwards. `bin` is the honest
 * answer when neither source offers anything usable.
 */
function extensionHint(telegramPath: string, originalName: string | undefined): string {
  for (const candidate of [telegramPath, originalName]) {
    if (candidate === undefined) continue;
    const match = /\.([A-Za-z0-9]{1,12})$/.exec(candidate);
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return 'bin';
}
