export { hasSessionUser } from './context.js';
export type { AppContext, AppContextFlavor, SessionUser } from './context.js';

export { createBot, createTelegramApi } from './bot-factory.js';
export type { CreateBotOptions } from './bot-factory.js';

export { classifyTelegramError, isRetryableTelegramError } from './telegram-errors.js';
export type { TelegramErrorInfo, TelegramErrorKind } from './telegram-errors.js';

export {
  TELEGRAM_CAPTION_MAX_LENGTH,
  TELEGRAM_MESSAGE_MAX_LENGTH,
  clampCaption,
  clampMessage,
  clampText,
  escapeHtml,
} from './html.js';

export { answerCallbackSafely, editStatusMessage } from './safe-messaging.js';
export type { EditOutcome, EditStatusOptions } from './safe-messaging.js';

export type { BotFeature, FeatureCommand } from './feature.js';
