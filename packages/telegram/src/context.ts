import type { Logger } from '@tgtools/shared';
import type { Context } from 'grammy';

/**
 * The transport's view of the person on the other end. Deliberately minimal:
 * the users feature owns the full record, and a handler that needs more should
 * ask a use case rather than widen this.
 */
export interface SessionUser {
  /** Our own identifier, not Telegram's. */
  readonly id: string;
  readonly telegramUserId: number;
  readonly languageCode: string | undefined;
  readonly isBlocked: boolean;
}

/**
 * Fields the middleware stack attaches to every update.
 *
 * `requestId` is what ties a log line in the bot to a log line in the worker
 * twenty minutes later, so it is threaded through the job payload rather than
 * regenerated.
 */
export interface AppContextFlavor {
  requestId: string;
  logger: Logger;
  user: SessionUser;
}

/** The context every feature handler receives. */
export type AppContext = Context & AppContextFlavor;

/**
 * True once the user middleware has run. Handlers registered before it — or on
 * an update with no `from`, such as a channel post — must check this rather
 * than trust the type.
 */
export function hasSessionUser(ctx: Context): ctx is AppContext {
  return typeof (ctx as Partial<AppContextFlavor>).user?.id === 'string';
}
