import type { Logger } from '@tgtools/shared';
import type { Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { clampMessage } from './html.js';
import { classifyTelegramError } from './telegram-errors.js';

export interface EditStatusOptions {
  readonly api: Api;
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly logger: Logger;
  readonly replyMarkup?: InlineKeyboardMarkup | undefined;
}

export type EditOutcome = 'edited' | 'unchanged' | 'gone' | 'failed';

/**
 * Edit a status message without letting the attempt take down the job.
 *
 * The reference implementation wrote `.catch(() => {})` here, and the result was
 * that a user could sit in front of "queued" for half an hour while the download
 * ran perfectly — every edit was failing and nothing said so. So: distinguish
 * the outcomes, stay quiet about the two that are normal, and log the rest.
 */
export async function editStatusMessage(options: EditStatusOptions): Promise<EditOutcome> {
  const { api, chatId, messageId, logger } = options;
  try {
    await api.editMessageText(chatId, messageId, clampMessage(options.text), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(options.replyMarkup === undefined ? {} : { reply_markup: options.replyMarkup }),
    });
    return 'edited';
  } catch (error: unknown) {
    const info = classifyTelegramError(error);
    switch (info.kind) {
      case 'not_modified':
        // Expected: the throttler produced identical text. Not worth a log line.
        return 'unchanged';
      case 'message_unavailable':
      case 'blocked_by_user':
      case 'chat_not_found':
        logger.debug('status message no longer reachable', { kind: info.kind, chatId, messageId });
        return 'gone';
      default:
        logger.warn('failed to edit status message', {
          kind: info.kind,
          chatId,
          messageId,
          description: info.description,
        });
        return 'failed';
    }
  }
}

/**
 * Answer a callback query, tolerating the one failure that is guaranteed to
 * happen: a query older than Telegram's ~15 second acceptance window, typically
 * because the user tapped while the bot was restarting.
 */
export async function answerCallbackSafely(
  api: Api,
  callbackQueryId: string,
  logger: Logger,
  options: { text?: string; showAlert?: boolean } = {},
): Promise<void> {
  try {
    await api.answerCallbackQuery(callbackQueryId, {
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.showAlert === undefined ? {} : { show_alert: options.showAlert }),
    });
  } catch (error: unknown) {
    const info = classifyTelegramError(error);
    logger.debug('callback query could not be answered', {
      kind: info.kind,
      description: info.description,
    });
  }
}
