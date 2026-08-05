import { stat } from 'node:fs/promises';
import { ToolError, ToolErrorCode } from '@tgtools/file-tools-engine';
import type { Logger, ToolKey } from '@tgtools/shared';
import { throwIfAborted, withTimeout } from '@tgtools/shared';
import { clampCaption, isRetryableTelegramError } from '@tgtools/telegram';
import type { Api } from 'grammy';
import { InputFile } from 'grammy';

/**
 * Handing the finished file back to the user.
 *
 * The one decision worth stating is that almost everything goes out as a
 * DOCUMENT rather than as a photo. Telegram re-encodes anything sent through
 * `sendPhoto` — it strips metadata, caps the long edge and applies its own JPEG
 * quality — which for a compression tool would mean the number the user was
 * shown had nothing to do with the file they received, and for a format
 * conversion would mean the WebP they asked for arrived as a JPEG.
 *
 * A QR code goes out as a document for the same reason from the other
 * direction: JPEG ringing around the finder patterns is exactly the artefact
 * that makes a code fail to scan, and a code that scans on the sender's screen
 * and not on the recipient's is the worst possible outcome.
 */

export interface ToolResultSenderOptions {
  readonly api: Api;
  readonly logger: Logger;
  readonly maxUploadBytes: number;
  readonly uploadTimeoutMs: number;
}

export interface SendToolResultInput {
  readonly chatId: number;
  readonly tool: ToolKey;
  readonly path: string;
  readonly fileName: string;
  readonly caption: string | undefined;
  readonly signal: AbortSignal;
  /** Only for `video.remove_audio`; lets clients show a player rather than a file row. */
  readonly durationSeconds?: number | undefined;
}

export interface SentToolResult {
  readonly fileId: string | undefined;
  readonly fileUniqueId: string | undefined;
  readonly sizeBytes: number;
}

export class ToolResultSender {
  constructor(private readonly options: ToolResultSenderOptions) {}

  async send(input: SendToolResultInput): Promise<SentToolResult> {
    const { size } = await stat(input.path);

    // Checked before the upload rather than after Telegram refuses it. A
    // rejected 2 GB upload costs the whole transfer to learn what one `stat`
    // already knew.
    if (size > this.options.maxUploadBytes) {
      throw new ToolError(ToolErrorCode.OutputTooLarge, 'result is over the upload ceiling', {
        context: { sizeBytes: size, maxBytes: this.options.maxUploadBytes },
      });
    }

    // Checked once, here, rather than passed into grammy.
    //
    // grammy types its `signal` parameter against the `abort-controller`
    // polyfill rather than the platform `AbortSignal`, so handing it a native
    // one does not type-check — and the honest ways out are a cast that lies or
    // a dependency on the polyfill. Neither is worth it for a cancellation that
    // can only take effect between calls anyway: an upload already in flight is
    // bytes on a socket, and stopping it early does not un-send them.
    //
    // So: refuse to START an upload the user has cancelled, and bound the whole
    // attempt with a timeout. The same shape `GrammyMediaSender` uses.
    throwIfAborted(input.signal);

    const file = new InputFile(input.path, input.fileName);
    const caption = input.caption === undefined ? {} : { caption: clampCaption(input.caption) };

    try {
      // MP3 is the one genuine exception to the document rule: `sendAudio` is
      // what makes a track playable inline and gives it a title in the player,
      // and unlike photos Telegram does not re-encode it.
      if (input.tool === 'video.extract_mp3') {
        const message = await this.#bounded(
          this.options.api.sendAudio(input.chatId, file, { ...caption, parse_mode: 'HTML' }),
        );
        return {
          fileId: message.audio?.file_id,
          fileUniqueId: message.audio?.file_unique_id,
          sizeBytes: size,
        };
      }

      if (input.tool === 'video.remove_audio') {
        const message = await this.#bounded(
          this.options.api.sendVideo(input.chatId, file, {
            ...caption,
            parse_mode: 'HTML',
            // The video is untouched apart from the dropped audio track, so it
            // is still whatever the user sent — streamable, and worth telling
            // clients so they show a player instead of a file row.
            supports_streaming: true,
            ...(input.durationSeconds === undefined
              ? {}
              : { duration: Math.round(input.durationSeconds) }),
          }),
        );
        return {
          fileId: message.video?.file_id,
          fileUniqueId: message.video?.file_unique_id,
          sizeBytes: size,
        };
      }

      const message = await this.#bounded(
        this.options.api.sendDocument(input.chatId, file, { ...caption, parse_mode: 'HTML' }),
      );
      return {
        fileId: message.document?.file_id,
        fileUniqueId: message.document?.file_unique_id,
        sizeBytes: size,
      };
    } catch (error: unknown) {
      // Whether a second attempt could work is Telegram's answer to give, not
      // ours: a 429 or a 5xx is worth retrying and a "chat not found" never is.
      // Marking every upload failure retryable would have the worker re-encode
      // and re-upload to a chat the user has deleted.
      throw new ToolError(ToolErrorCode.TelegramUploadFailed, 'could not send the result', {
        cause: error,
        retryable: isRetryableTelegramError(error),
      });
    }
  }

  /** One ceiling per upload, so a stalled socket cannot hold a queue slot open forever. */
  #bounded<T>(call: Promise<T>): Promise<T> {
    return withTimeout(call, this.options.uploadTimeoutMs, 'telegram-upload');
  }
}
