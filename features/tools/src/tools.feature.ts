import type { AppConfig } from '@tgtools/config';
import type { Clock, IdGenerator, Logger, ToolKey } from '@tgtools/shared';
import { describeError, toolFamilyOf } from '@tgtools/shared';
import type { AppContext, BotFeature } from '@tgtools/telegram';
import {
  CallbackNamespace,
  answerCallbackSafely,
  decodeCallback,
  isCurrentVersion,
} from '@tgtools/telegram';
import type { ToolInputReference, ToolSession } from '@tgtools/tool-contracts';
import { TOOL_SESSION_SCHEMA_VERSION, expectedInputCount } from '@tgtools/tool-contracts';
import { Composer, InlineKeyboard } from 'grammy';
import type { RequestToolJobUseCase } from './application/request-tool-job.use-case.js';
import type { RedisToolSessionStore } from './infrastructure/session/redis-tool-session-store.js';
import { buildToolOperation } from './presentation/telegram/build-operation.js';
import {
  toolFromCallbackCode,
  familyFromCallbackCode,
} from './presentation/telegram/callback-codes.js';
import {
  MenuAction,
  familyMenuKeyboard,
  toolMenuKeyboard,
} from './presentation/telegram/keyboards/menu.keyboard.js';
import { faTools, TOOL_LABELS_FA } from './presentation/telegram/messages/fa.js';
import { isOfferedChoice, nextOptionStep } from './presentation/telegram/option-steps.js';
import type { ToolOptionStep } from './presentation/telegram/option-steps.js';

/**
 * The conversation: menu, file, options, confirm.
 *
 * Deliberately thin. Every decision it makes — which question is next, whether
 * a tapped value was offered, whether the answers add up to a valid operation —
 * is a pure function tested in the unit suite. What is left here is Telegram
 * plumbing, which is the part that cannot be tested without a Telegram.
 *
 * The session in Redis is the single source of truth for where a user is. It is
 * re-read on every update rather than held in memory, because two bot replicas
 * behind one token would otherwise disagree about the same conversation.
 */

/** Actions in the `tm` namespace beyond navigation. */
const Action = {
  ...MenuAction,
  /** An answer to the current option step: the argument is the chosen value. */
  Answer: 'a',
  /** Finished sending files (images-to-PDF). */
  Done: 'd',
  Confirm: 'go',
  Cancel: 'x',
} as const;

export interface ToolsFeatureDeps {
  readonly config: AppConfig;
  readonly sessions: RedisToolSessionStore;
  readonly requestJob: RequestToolJobUseCase;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createToolsFeature(deps: ToolsFeatureDeps): BotFeature {
  const composer = new Composer<AppContext>();
  const tools = deps.config.tools;

  const enabledFamilies = {
    image: tools.imageEnabled,
    video: tools.videoEnabled,
    pdf: tools.pdfEnabled,
    qr: tools.qrEnabled,
  };

  const showRootMenu = async (ctx: AppContext, edit: boolean): Promise<void> => {
    const keyboard = familyMenuKeyboard(enabledFamilies);
    // Every family switched off is a configuration state, not a user error, and
    // Telegram refuses a keyboard with no buttons anyway.
    if (keyboard.inline_keyboard.length === 0) {
      await ctx.reply(faTools.toolsDisabled);
      return;
    }
    const text = `${faTools.menuIntro}\n\n${faTools.menuTitle}`;
    if (edit) await ctx.editMessageText(text, { reply_markup: keyboard }).catch(() => undefined);
    else await ctx.reply(text, { reply_markup: keyboard });
  };

  const startFlow = async (ctx: AppContext, tool: ToolKey): Promise<void> => {
    const session: ToolSession = {
      schemaVersion: TOOL_SESSION_SCHEMA_VERSION,
      tool,
      createdAtMs: deps.clock.now().getTime(),
      state: 'awaiting_input',
    };
    await deps.sessions.save(ctx.user.telegramUserId, session);

    // QR takes no file at all, so it goes straight to its questions rather than
    // asking for an upload it has no use for.
    if (expectedInputCount(tool).max === 0) {
      await deps.sessions.save(ctx.user.telegramUserId, {
        ...session,
        state: 'awaiting_options',
        inputs: [PLACEHOLDER_INPUT],
        draftOptions: {},
        step: 'start',
      });
      await askNext(ctx, tool, {});
      return;
    }

    const many = expectedInputCount(tool).max > 1;
    await ctx
      .editMessageText(
        `${TOOL_LABELS_FA[tool]}\n\n${many ? faTools.sendTheImages : faTools.sendTheFile}`,
        { reply_markup: new InlineKeyboard().text(faTools.buttonCancel, cb(Action.Cancel)) },
      )
      .catch(() => undefined);
  };

  const askNext = async (
    ctx: AppContext,
    tool: ToolKey,
    draft: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const step = nextOptionStep(tool, draft);
    if (step === undefined) {
      await askConfirmation(ctx, tool);
      return;
    }
    await sendStep(ctx, step);
  };

  const sendStep = async (ctx: AppContext, step: ToolOptionStep): Promise<void> => {
    if (step.kind === 'text') {
      await ctx.reply(step.prompt, {
        reply_markup: new InlineKeyboard().text(faTools.buttonCancel, cb(Action.Cancel)),
      });
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const choice of step.choices) {
      keyboard.text(choice.label, cb(Action.Answer, choice.value)).row();
    }
    keyboard.text(faTools.buttonCancel, cb(Action.Cancel));
    await ctx.reply(step.prompt, { reply_markup: keyboard });
  };

  const askConfirmation = async (ctx: AppContext, tool: ToolKey): Promise<void> => {
    await ctx.reply(`${TOOL_LABELS_FA[tool]}\n\nهمه‌چیز آماده است. شروع کنیم؟`, {
      reply_markup: new InlineKeyboard()
        .text(faTools.buttonConfirm, cb(Action.Confirm))
        .row()
        .text(faTools.buttonCancel, cb(Action.Cancel)),
    });
  };

  // ---- commands ----

  composer.command(['menu', 'tools'], async (ctx) => {
    // Starting a new flow abandons whatever was in progress. Anything else
    // means a user who mistyped is stuck until the TTL expires.
    await deps.sessions.clear(ctx.user.telegramUserId);
    await showRootMenu(ctx, false);
  });

  // ---- callbacks ----

  composer.on('callback_query:data', async (ctx, next) => {
    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (decoded?.namespace !== CallbackNamespace.ToolMenu) {
      // Not ours. The downloader's callbacks use different namespaces.
      await next();
      return;
    }
    if (!isCurrentVersion(decoded)) {
      await answerCallbackSafely(ctx.api, ctx.callbackQuery.id, ctx.logger, {
        text: faTools.callbackExpired,
        showAlert: true,
      });
      return;
    }

    await answerCallbackSafely(ctx.api, ctx.callbackQuery.id, ctx.logger);
    const userId = ctx.user.telegramUserId;

    try {
      switch (decoded.action) {
        case Action.Root:
          await deps.sessions.clear(userId);
          await showRootMenu(ctx, true);
          return;

        case Action.OpenFamily: {
          const family =
            decoded.arg === undefined ? undefined : familyFromCallbackCode(decoded.arg);
          if (family === undefined) return;
          await ctx
            .editMessageText(faTools.menuTitle, { reply_markup: toolMenuKeyboard(family) })
            .catch(() => undefined);
          return;
        }

        case Action.PickTool: {
          const tool = decoded.arg === undefined ? undefined : toolFromCallbackCode(decoded.arg);
          // A family switched off after the button was sent, or a hand-made
          // payload. Either way the queue would never be drained.
          if (tool === undefined || !enabledFamilies[toolFamilyOf(tool)]) {
            await ctx.reply(faTools.toolsDisabled);
            return;
          }
          await startFlow(ctx, tool);
          return;
        }

        case Action.Cancel:
          await deps.sessions.clear(userId);
          await ctx.reply(faTools.cancelled);
          return;

        case Action.Answer: {
          const session = await deps.sessions.load(userId);
          if (session?.state !== 'awaiting_options') return;

          const step = nextOptionStep(session.tool, session.draftOptions);
          // Checked against what the step ACTUALLY offered: callback data is
          // attacker-controlled, and every button ever sent stays clickable.
          if (
            step === undefined ||
            decoded.arg === undefined ||
            !isOfferedChoice(step, decoded.arg)
          ) {
            return;
          }

          const draftOptions = { ...session.draftOptions, [step.id]: decoded.arg };
          await deps.sessions.save(userId, { ...session, draftOptions });
          await askNext(ctx, session.tool, draftOptions);
          return;
        }

        case Action.Done: {
          const session = await deps.sessions.load(userId);
          if (session?.state !== 'collecting_inputs') return;
          await deps.sessions.save(userId, {
            ...session,
            state: 'awaiting_options',
            draftOptions: {},
            step: 'start',
          });
          await askNext(ctx, session.tool, {});
          return;
        }

        case Action.Confirm:
          await confirm(ctx);
          return;

        default:
          return;
      }
    } catch (error: unknown) {
      deps.logger.error('tool callback failed', { error: describeError(error) });
      await ctx.reply(faTools.failure('INTERNAL_ERROR')).catch(() => undefined);
    }
  });

  // ---- incoming files ----

  composer.on(['message:photo', 'message:document', 'message:video'], async (ctx, next) => {
    const userId = ctx.user.telegramUserId;
    const session = await deps.sessions.load(userId);
    // No session means this file is not for us — the downloader and any other
    // feature must still see it.
    if (session === undefined) {
      await next();
      return;
    }
    if (session.state !== 'awaiting_input' && session.state !== 'collecting_inputs') {
      await next();
      return;
    }

    const reference = referenceFrom(ctx, deps.clock.now().getTime());
    if (reference === undefined) {
      await next();
      return;
    }

    const collected =
      session.state === 'collecting_inputs' ? [...session.inputs, reference] : [reference];
    const limit = expectedInputCount(session.tool);

    if (collected.length >= limit.max) {
      // Enough files for this tool. Move straight to its questions rather than
      // making the user press a button to say what is already known.
      await deps.sessions.save(userId, {
        ...session,
        state: 'awaiting_options',
        inputs: collected.slice(0, limit.max),
        draftOptions: {},
        step: 'start',
      });
      await askNext(ctx, session.tool, {});
      return;
    }

    await deps.sessions.save(userId, {
      ...session,
      state: 'collecting_inputs',
      inputs: collected,
    });

    await ctx.reply(`📎 ${String(collected.length)} فایل دریافت شد. می‌توانید باز هم بفرستید.`, {
      reply_markup: new InlineKeyboard()
        .text(faTools.buttonDone, cb(Action.Done))
        .row()
        .text(faTools.buttonCancel, cb(Action.Cancel)),
    });
  });

  // ---- typed answers ----

  composer.on('message:text', async (ctx, next) => {
    const userId = ctx.user.telegramUserId;
    const session = await deps.sessions.load(userId);
    if (session?.state !== 'awaiting_options') {
      await next();
      return;
    }

    const step = nextOptionStep(session.tool, session.draftOptions);
    // Only a TEXT step consumes a typed message. Anything else and the text is
    // someone's link for the downloader, which must still reach it.
    if (step?.kind !== 'text') {
      await next();
      return;
    }

    const draftOptions = { ...session.draftOptions, [step.id]: ctx.message.text };
    await deps.sessions.save(userId, { ...session, draftOptions });

    // Deleting the message the content arrived in. For a Wi-Fi password or a
    // private URL, leaving it in the chat history is the one place this
    // feature's care about secrets would otherwise leak.
    if (session.tool === 'qr.generate') {
      await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => undefined);
    }

    await askNext(ctx, session.tool, draftOptions);
  });

  const confirm = async (ctx: AppContext): Promise<void> => {
    const userId = ctx.user.telegramUserId;
    const session = await deps.sessions.load(userId);
    if (session?.state !== 'awaiting_options') {
      await ctx.reply(faTools.callbackExpired);
      return;
    }

    const built = buildToolOperation(session.tool, session.draftOptions);
    if (!built.ok) {
      deps.logger.warn('a confirmed tool flow did not produce a valid operation', {
        tool: session.tool,
        reason: built.reason,
      });
      await deps.sessions.clear(userId);
      await ctx.reply(faTools.failure('INTERNAL_ERROR'));
      return;
    }

    const status = await ctx.reply(faTools.status('pending'));

    const inputs: ToolInputReference[] =
      expectedInputCount(session.tool).max === 0 ? [] : [...session.inputs];

    const result = await deps.requestJob.execute({
      userId: ctx.user.id,
      telegramUserId: userId,
      telegramChatId: ctx.chat?.id ?? userId,
      statusMessageId: status.message_id,
      requestId: ctx.requestId,
      tool: session.tool,
      operation: built.operation,
      inputs,
    });

    // Cleared either way. A session left behind makes the user's next,
    // unrelated photo look like an input to a job that already started.
    await deps.sessions.clear(userId);

    if (!result.ok) {
      await ctx.api
        .editMessageText(ctx.chat?.id ?? userId, status.message_id, faTools.tooManyActiveJobs)
        .catch(() => undefined);
      return;
    }

    await ctx.api
      .editMessageText(ctx.chat?.id ?? userId, status.message_id, faTools.status('queued'))
      .catch(() => undefined);
  };

  return {
    name: 'tools',
    composer,
    commands: [{ command: 'menu', description: 'ابزارهای فایل' }],
  };
}

/** Builds `tm`-namespaced callback data. Kept local so the actions stay together. */
function cb(action: string, arg?: string): string {
  const parts = ['tm', 'v1', action];
  if (arg !== undefined) parts.push(arg);
  return parts.join(':');
}

/**
 * A stand-in so a QR session satisfies the schema's `min(1)` on inputs.
 *
 * QR takes no file, but the session variants that hold options all require at
 * least one input — the schema was written for the seven tools that do. The
 * placeholder never reaches a job: `confirm` sends an empty array for any tool
 * whose expected input count is zero.
 */
const PLACEHOLDER_INPUT: ToolInputReference = {
  fileId: 'none',
  fileUniqueId: 'none',
  receivedAtMs: 0,
};

/** The Telegram reference for whichever kind of attachment arrived. */
function referenceFrom(ctx: AppContext, receivedAtMs: number): ToolInputReference | undefined {
  const message = ctx.message;
  if (message === undefined) return undefined;

  if (message.photo !== undefined && message.photo.length > 0) {
    // The LAST entry is the largest rendition Telegram kept. Any other choice
    // silently processes a thumbnail.
    const largest = message.photo[message.photo.length - 1];
    if (largest === undefined) return undefined;
    return {
      fileId: largest.file_id,
      fileUniqueId: largest.file_unique_id,
      ...(largest.file_size === undefined ? {} : { declaredSize: largest.file_size }),
      receivedAtMs,
    };
  }

  const file = message.document ?? message.video;
  if (file === undefined) return undefined;
  return {
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    ...(file.file_size === undefined ? {} : { declaredSize: file.file_size }),
    ...(file.mime_type === undefined ? {} : { declaredMimeType: file.mime_type }),
    ...('file_name' in file && file.file_name !== undefined
      ? { originalName: file.file_name }
      : {}),
    receivedAtMs,
  };
}
