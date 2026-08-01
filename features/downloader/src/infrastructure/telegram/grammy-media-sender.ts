import { DownloadType } from '@tgtools/shared';
import type { Logger } from '@tgtools/shared';
import { assertNever, createAbortScope } from '@tgtools/shared';
import { classifyTelegramError, clampCaption } from '@tgtools/telegram';
import type { Api } from 'grammy';
import { InputFile } from 'grammy';
import type { Message } from 'grammy/types';
import { DownloadError } from '../../domain/errors/download-error.js';
import { DownloadFailureCode } from '../../domain/errors/download-failure-code.js';
import type {
  SendMediaCommand,
  SentMedia,
  TelegramMediaSenderPort,
} from '../../domain/ports/supporting-ports.js';

export interface GrammyMediaSenderOptions {
  readonly api: Api;
  readonly logger: Logger;
  readonly uploadTimeoutMs: number;
  readonly maxUploadBytes: number;
}

/**
 * Puts the finished file in front of the user.
 *
 * The interesting part is the fallback: Telegram accepts an upload and then
 * decides for itself whether the result is playable. When it refuses, the bytes
 * are fine and only the *presentation* was wrong, so re-sending the same file
 * as a document delivers it instead of failing the job.
 */
export class GrammyMediaSender implements TelegramMediaSenderPort {
  constructor(private readonly options: GrammyMediaSenderOptions) {}

  async send(command: SendMediaCommand): Promise<SentMedia> {
    if (command.fileSize > this.options.maxUploadBytes) {
      throw new DownloadError(
        DownloadFailureCode.MediaTooLarge,
        `File exceeds the configured upload ceiling`,
        { context: { fileSize: command.fileSize, max: this.options.maxUploadBytes } },
      );
    }

    const scope = createAbortScope({
      parent: command.signal,
      timeoutMs: this.options.uploadTimeoutMs,
      label: 'telegram-upload',
    });

    try {
      return await this.#sendTyped(command);
    } catch (error: unknown) {
      const info = classifyTelegramError(error);

      if (info.kind === 'unsupported_content' && command.type !== DownloadType.Image) {
        this.options.logger.warn('telegram refused the typed send; retrying as a document', {
          kind: info.kind,
          description: info.description,
        });
        // Awaited inside the try so the upload timeout in `finally` is still
        // live while the fallback runs.
        return await this.#sendAsDocument(command);
      }

      if (info.kind === 'file_too_large') {
        throw new DownloadError(
          DownloadFailureCode.MediaTooLarge,
          'Telegram refused the upload as too large',
          { cause: error },
        );
      }

      throw new DownloadError(DownloadFailureCode.UploadFailed, info.description, {
        cause: error,
        retryable: info.retryable,
      });
    } finally {
      scope.dispose();
    }
  }

  async #sendTyped(command: SendMediaCommand): Promise<SentMedia> {
    const caption = clampCaption(command.caption);
    const file = new InputFile(command.filePath, command.fileName);

    switch (command.type) {
      case DownloadType.Video: {
        const message = await this.options.api.sendVideo(command.chatId, file, {
          caption,
          parse_mode: 'HTML',
          // Without these Telegram shows a black box with a 00:00 timer instead
          // of an inline player, even for a perfectly good H.264 file.
          supports_streaming: true,
          ...(command.video?.duration === undefined
            ? {}
            : { duration: Math.round(command.video.duration) }),
          ...(command.video?.width === undefined ? {} : { width: command.video.width }),
          ...(command.video?.height === undefined ? {} : { height: command.video.height }),
          ...(command.video?.thumbnailPath === undefined
            ? {}
            : { thumbnail: new InputFile(command.video.thumbnailPath) }),
        });
        return { fileId: message.video?.file_id, messageId: message.message_id };
      }

      case DownloadType.Audio: {
        const message = await this.options.api.sendAudio(command.chatId, file, {
          caption,
          parse_mode: 'HTML',
          ...(command.video?.duration === undefined
            ? {}
            : { duration: Math.round(command.video.duration) }),
        });
        return { fileId: message.audio?.file_id, messageId: message.message_id };
      }

      case DownloadType.Image: {
        const message = await this.options.api.sendPhoto(command.chatId, file, {
          caption,
          parse_mode: 'HTML',
        });
        return { fileId: largestPhotoId(message), messageId: message.message_id };
      }

      default:
        return assertNever(command.type, 'download type');
    }
  }

  async #sendAsDocument(command: SendMediaCommand): Promise<SentMedia> {
    const message = await this.options.api.sendDocument(
      command.chatId,
      new InputFile(command.filePath, command.fileName),
      {
        caption: clampCaption(command.caption),
        parse_mode: 'HTML',
        ...(command.video?.thumbnailPath === undefined
          ? {}
          : { thumbnail: new InputFile(command.video.thumbnailPath) }),
      },
    );
    return { fileId: message.document?.file_id, messageId: message.message_id };
  }
}

/** Telegram returns every rendition; the last is the largest. */
function largestPhotoId(message: Message): string | undefined {
  const photos = message.photo;
  if (photos === undefined || photos.length === 0) return undefined;
  return photos[photos.length - 1]?.file_id;
}
