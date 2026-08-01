import { extractUrls } from '@tgtools/downloader-engine';
import { describeError } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import { editStatusMessage } from '@tgtools/telegram';
import type { InspectMediaUseCase } from '../../../application/use-cases/inspect-media.use-case.js';
import { toDownloadError } from '../../../domain/errors/download-error.js';
import { renderMediaCard } from '../presenters/media-card.presenter.js';
import { fa } from '../messages/fa.js';

export interface LinkMessageHandlerDependencies {
  readonly inspectMedia: InspectMediaUseCase;
}

/**
 * The entry point for "user pasted a link".
 *
 * The handler is deliberately thin: read the update, build a command, run a use
 * case, render the answer. Every decision worth testing lives one layer down,
 * where it can be tested without a Telegram update object.
 */
export function createLinkMessageHandler(deps: LinkMessageHandlerDependencies) {
  return async (ctx: AppContext): Promise<void> => {
    const text = ctx.message?.text ?? ctx.message?.caption;
    if (text === undefined) return;

    const { urls, isCommand } = extractUrls(text);
    // `/start https://…` is a deep link, not a download request; treating it as
    // one would kick off a download for every referral link.
    if (isCommand) return;

    if (urls.length === 0) {
      await ctx.reply(fa.noUrlFound, { link_preview_options: { is_disabled: true } });
      return;
    }

    if (urls.length > 1) {
      await ctx.reply(fa.multipleUrls, { link_preview_options: { is_disabled: true } });
    }

    const status = await ctx.reply(fa.inspecting, {
      link_preview_options: { is_disabled: true },
    });

    try {
      const result = await deps.inspectMedia.execute({
        userId: ctx.user.id,
        telegramChatId: ctx.chat?.id ?? ctx.user.telegramUserId,
        // The first supported link is the one the user meant.
        rawUrl: urls[0] ?? '',
      });

      const card = renderMediaCard(result.shortId, result.info);
      await editStatusMessage({
        api: ctx.api,
        chatId: status.chat.id,
        messageId: status.message_id,
        text: card.text,
        logger: ctx.logger,
        replyMarkup: card.keyboard,
      });
    } catch (error: unknown) {
      const failure = toDownloadError(error);
      ctx.logger.warn('link inspection failed', {
        code: failure.code,
        error: describeError(error),
      });
      // The user gets the mapped sentence; the technical detail stays in the log.
      await editStatusMessage({
        api: ctx.api,
        chatId: status.chat.id,
        messageId: status.message_id,
        text: fa.failure(failure.code),
        logger: ctx.logger,
      });
    }
  };
}
