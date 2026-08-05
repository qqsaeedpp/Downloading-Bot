export { hasSessionUser } from './context.js';
export type { AppContext, AppContextFlavor, SessionUser } from './context.js';

export { createBot, createTelegramApi, resolveApiRoot } from './bot-factory.js';
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

export { PUBLIC_BOT_API_ROOT, PUBLIC_BOT_API_ROOT_LABEL } from './api-root.js';

export {
  CALLBACK_DATA_MAX_BYTES,
  CALLBACK_VERSION,
  CallbackEncodingError,
  CallbackNamespace,
  createShortId,
  decodeCallback,
  encodeCallback,
  isCurrentVersion,
} from './callback-codec.js';
export type { DecodedCallback } from './callback-codec.js';
export {
  BOT_TOKEN_PLACEHOLDER,
  resolveTelegramFilePath,
  withBotToken,
} from './local-file-resolver.js';
export type { ResolvedTelegramFile } from './local-file-resolver.js';

export { answerCallbackSafely, editStatusMessage } from './safe-messaging.js';
export type { EditOutcome, EditStatusOptions } from './safe-messaging.js';

export type { BotFeature, FeatureCommand } from './feature.js';
