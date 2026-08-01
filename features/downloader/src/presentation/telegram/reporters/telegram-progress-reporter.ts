import { DownloadStage } from '@tgtools/shared';
import type { DownloadProgress, Logger } from '@tgtools/shared';
import { editStatusMessage } from '@tgtools/telegram';
import type { Api } from 'grammy';
import type { DownloadFailureCode } from '../../../domain/errors/download-failure-code.js';
import type { DownloadProgressReporter } from '../../../domain/ports/supporting-ports.js';
import { buildCancelKeyboard } from '../keyboards/quality.keyboard.js';
import { fa } from '../messages/fa.js';

export interface TelegramProgressReporterOptions {
  readonly api: Api;
  readonly chatId: number;
  readonly messageId: number;
  readonly shortId: string;
  readonly logger: Logger;
}

/**
 * Writes what the worker is doing into the user's status message.
 *
 * Lives in presentation, not in the use case, so that the worker's pipeline
 * stays free of Persian and of grammY. The throttling decision is made
 * upstream — by the time a call arrives here, it has already been judged worth
 * making.
 */
export class TelegramProgressReporter implements DownloadProgressReporter {
  #lastText: string | undefined;

  constructor(private readonly options: TelegramProgressReporterOptions) {}

  async onStage(stage: DownloadStage): Promise<void> {
    // The cancel button stays attached for as long as cancelling can still
    // achieve something; once the file is going up, it cannot.
    const keyboard =
      stage === DownloadStage.Uploading ? undefined : buildCancelKeyboard(this.options.shortId);
    await this.#write(fa.stage(stage), keyboard);
  }

  async onProgress(progress: DownloadProgress): Promise<void> {
    await this.#write(
      fa.downloadProgress({
        percent: progress.percent,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        speedBytesPerSecond: progress.speedBytesPerSecond,
        etaSeconds: progress.etaSeconds,
      }),
      buildCancelKeyboard(this.options.shortId),
    );
  }

  async onCompleted(summary: { readonly fileSize: number }): Promise<void> {
    await this.#write(fa.completed(summary.fileSize), undefined);
  }

  async onFailed(code: DownloadFailureCode): Promise<void> {
    await this.#write(fa.failure(code), undefined);
  }

  async #write(
    text: string,
    keyboard: ReturnType<typeof buildCancelKeyboard> | undefined,
  ): Promise<void> {
    // Telegram answers an unchanged edit with a 400. Comparing locally saves
    // the round trip as well as the error.
    if (text === this.#lastText) return;
    this.#lastText = text;
    await editStatusMessage({
      api: this.options.api,
      chatId: this.options.chatId,
      messageId: this.options.messageId,
      text,
      logger: this.options.logger,
      replyMarkup: keyboard,
    });
  }
}
