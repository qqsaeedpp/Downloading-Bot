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
  /**
   * Logged with every delivery so a "why was this rejected" question can be
   * answered from the log alone. Never carries the token: the token lives in the
   * `Api` instance, not in the root.
   */
  readonly apiRoot: string;
  /** Injectable purely so a test can assert the zero-byte and size guards. */
  readonly statFile?: (path: string) => Promise<{ size: number }>;
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
    // Measured from the file on disk, not from what the engine remembered. This
    // is the last point before bytes leave the machine, and a file that was
    // truncated or swept between finalisation and upload should fail here with
    // a reason rather than as an opaque Telegram rejection.
    const actualSize = await this.#measure(command.filePath, command.fileSize);

    if (actualSize === 0) {
      throw new DownloadError(
        DownloadFailureCode.ProcessingFailed,
        'Refusing to send an empty file',
        {
          context: { filePath: command.fileName },
        },
      );
    }

    if (actualSize > this.options.maxUploadBytes) {
      throw new DownloadError(
        DownloadFailureCode.MediaTooLarge,
        `File exceeds the configured upload ceiling`,
        { context: { fileSize: actualSize, max: this.options.maxUploadBytes } },
      );
    }

    const scope = createAbortScope({
      parent: command.signal,
      timeoutMs: this.options.uploadTimeoutMs,
      label: 'telegram-upload',
    });

    const startedAt = Date.now();
    let attemptedAs: 'video' | 'audio' | 'photo' | 'document' = 'document';

    try {
      // The whole point of `deliveryMode`. ffprobe already established that
      // Telegram cannot stream this codec, so trying `sendVideo` first would
      // push the entire file — up to 1.9 GB — only to be told what was already
      // known, and then push it a second time as a document.
      if (this.#prefersDocument(command)) {
        const sent = await this.#sendAsDocument(command);
        this.#logDelivery(command, actualSize, 'document', startedAt, undefined);
        return sent;
      }

      attemptedAs = typeToLabel(command.type);
      const sent = await this.#sendTyped(command);
      this.#logDelivery(command, actualSize, attemptedAs, startedAt, undefined);
      return sent;
    } catch (error: unknown) {
      const info = classifyTelegramError(error);

      // Only `unsupported_content`, and only if a document is not what already
      // failed. An auth failure, a missing chat or a block means the same file
      // to the same chat fails identically; and retrying a document AS a
      // document would upload every byte a second time to reach the same
      // refusal — the precise double-upload `deliveryMode` exists to avoid.
      if (
        info.kind === 'unsupported_content' &&
        command.type !== DownloadType.Image &&
        attemptedAs !== 'document'
      ) {
        this.options.logger.warn('telegram refused the typed send; retrying as a document', {
          kind: info.kind,
          description: info.description,
        });
        // Awaited inside the try so the upload timeout in `finally` is still
        // live while the fallback runs.
        const sent = await this.#sendAsDocument(command);
        this.#logDelivery(command, actualSize, 'document', startedAt, `fallback:${attemptedAs}`);
        return sent;
      }

      this.#logDelivery(command, actualSize, attemptedAs, startedAt, `failed:${info.kind}`);

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

  /**
   * Only a video can be demoted to a document. An image sent as a file loses
   * its inline preview for no benefit, and audio has no such failure mode.
   */
  #prefersDocument(command: SendMediaCommand): boolean {
    return command.deliveryMode === 'direct-document' && command.type === DownloadType.Video;
  }

  async #measure(filePath: string, reported: number): Promise<number> {
    const stat = this.options.statFile;
    if (stat === undefined) return reported;
    try {
      return (await stat(filePath)).size;
    } catch {
      // A stat failure is not itself a reason to refuse: the upload will fail
      // with a better message than anything invented here.
      return reported;
    }
  }

  /**
   * One line per delivery, carrying everything needed to answer "why did this
   * arrive like that" without reproducing the job.
   *
   * `apiRoot` is the bare root — the token lives in the `Api` instance and never
   * appears in a URL here.
   */
  #logDelivery(
    command: SendMediaCommand,
    sourceBytes: number,
    sentAs: string,
    startedAt: number,
    outcome: string | undefined,
  ): void {
    this.options.logger.info('media delivered', {
      jobId: command.jobId,
      selectedQuality: command.selectedQuality,
      sourceSizeMb: toMegabytes(command.fileSize),
      outputSizeMb: toMegabytes(sourceBytes),
      videoCodec: command.video?.videoCodec,
      audioCodec: command.video?.audioCodec,
      container: command.video?.container,
      deliveryMode: command.deliveryMode,
      transcodeSkippedReason: command.transcodeSkippedReason,
      telegramApiRoot: this.options.apiRoot,
      telegramUploadLimitMb: toMegabytes(this.options.maxUploadBytes),
      uploadDurationMs: Date.now() - startedAt,
      sentAs,
      ...(outcome === undefined ? {} : { outcome }),
    });
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

function typeToLabel(type: DownloadType): 'video' | 'audio' | 'photo' | 'document' {
  switch (type) {
    case DownloadType.Video:
      return 'video';
    case DownloadType.Audio:
      return 'audio';
    case DownloadType.Image:
      return 'photo';
    default:
      return assertNever(type, 'download type');
  }
}

/** Whole megabytes. The log is for humans reasoning about limits, not accounting. */
function toMegabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** Telegram returns every rendition; the last is the largest. */
function largestPhotoId(message: Message): string | undefined {
  const photos = message.photo;
  if (photos === undefined || photos.length === 0) return undefined;
  return photos[photos.length - 1]?.file_id;
}
