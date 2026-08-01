import { describeError } from '@tgtools/shared';
import type { AppContext } from '@tgtools/telegram';
import { answerCallbackSafely, editStatusMessage } from '@tgtools/telegram';
import type { CancelDownloadUseCase } from '../../../application/use-cases/cancel-download.use-case.js';
import type { GetDownloadStatusUseCase } from '../../../application/use-cases/get-download-status.use-case.js';
import type { RequestDownloadUseCase } from '../../../application/use-cases/request-download.use-case.js';
import { toDownloadError } from '../../../domain/errors/download-error.js';
import type { MediaInspectionCache } from '../../../domain/ports/supporting-ports.js';
import type { DownloadOption } from '../../../domain/value-objects/download-option.js';
import { CallbackAction, decodeCallback } from '../callback-data.js';
import { fa } from '../messages/fa.js';

export interface DownloadCallbackHandlerDependencies {
  readonly requestDownload: RequestDownloadUseCase;
  readonly cancelDownload: CancelDownloadUseCase;
  readonly getStatus: GetDownloadStatusUseCase;
  readonly cache: MediaInspectionCache;
}

export function createDownloadCallbackHandler(deps: DownloadCallbackHandlerDependencies) {
  return async (ctx: AppContext): Promise<void> => {
    const query = ctx.callbackQuery;
    if (query === undefined) return;

    const callback = decodeCallback(query.data);
    if (callback === undefined) {
      // Not ours, or crafted. Answering keeps the client's spinner from hanging.
      await answerCallbackSafely(ctx.api, query.id, ctx.logger);
      return;
    }

    // Telegram gives roughly fifteen seconds to acknowledge a callback before
    // the client shows an error, and the work below can take longer than that.
    await answerCallbackSafely(ctx.api, query.id, ctx.logger, { text: fa.callbackAcknowledged });

    const messageId = query.message?.message_id;
    const chatId = query.message?.chat.id;
    if (messageId === undefined || chatId === undefined) return;

    try {
      if (callback.action === CallbackAction.Cancel) {
        const outcome = await deps.cancelDownload.execute({
          shortId: callback.shortId,
          actingUserId: ctx.user.id,
        });
        await editStatusMessage({
          api: ctx.api,
          chatId,
          messageId,
          text: outcome === 'cancelled' ? fa.cancelled : fa.alreadyFinished,
          logger: ctx.logger,
        });
        return;
      }

      const options = await loadOptions(deps, callback.shortId, ctx);
      await deps.requestDownload.execute({
        shortId: callback.shortId,
        optionId: callback.optionId ?? '',
        requestId: ctx.requestId,
        actingUserId: ctx.user.id,
        telegramUserId: ctx.user.telegramUserId,
        statusMessageId: messageId,
        availableOptions: options,
      });

      await editStatusMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: fa.queued,
        logger: ctx.logger,
      });
    } catch (error: unknown) {
      const failure = toDownloadError(error);
      ctx.logger.warn('download callback failed', {
        code: failure.code,
        error: describeError(error),
      });
      await editStatusMessage({
        api: ctx.api,
        chatId,
        messageId,
        text: fa.failure(failure.code),
        logger: ctx.logger,
      });
    }
  };
}

/**
 * Rebuild the option list the user was shown.
 *
 * The options are not carried in the callback data — 64 bytes does not hold
 * them — so they are recovered from the inspection cache, keyed by the job's
 * URL. If the cache has expired the selection has effectively expired too,
 * which is exactly what the use case is told.
 */
async function loadOptions(
  deps: DownloadCallbackHandlerDependencies,
  shortId: string,
  ctx: AppContext,
): Promise<readonly DownloadOption[]> {
  const job = await deps.getStatus.byShortId(shortId, ctx.user.id);
  if (job === undefined) return [];

  // Both cache namespaces are consulted: whether the original inspection needed
  // operator cookies is a property of that fetch, not of this tap.
  for (const requiredAuth of [false, true]) {
    const cached = await deps.cache.get({
      normalizedUrlHash: job.normalizedUrlHash,
      requiredAuth,
    });
    if (cached !== undefined) return cached.availableOptions;
  }
  return [];
}
