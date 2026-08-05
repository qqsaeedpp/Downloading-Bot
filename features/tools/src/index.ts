/**
 * The file-tools feature: everything about tool jobs EXCEPT running them.
 *
 * The one deliberate asymmetry with `@tgtools/feature-downloader` is what is
 * missing from the dependency list: `@tgtools/file-tools-engine`. Its entry
 * point loads Sharp's native binding, and the bot process — which imports this
 * package to serve menus and enqueue work — never decodes a pixel. Linking
 * libvips into the one process that must stay responsive to every user's
 * keystrokes, so that it can validate a page range, is not a trade worth making.
 *
 * So the split runs along the native dependency: this package owns the domain,
 * the persistence and the presentation, and `apps/tools-worker` owns the part
 * that actually opens files. The two meet at the ports below.
 */

export {
  ACTIVE_TOOL_STATUSES,
  InvalidToolTransitionError,
  assertToolTransition,
  canToolTransition,
  isToolJobTerminal,
} from './domain/tool-job-status.js';

export type { ToolJob, ToolJobOutput, ToolJobWithInputs } from './domain/tool-job.js';

export type {
  CompleteToolJobInput,
  CreateToolJobInput,
  ToolJobEventRepository,
  ToolJobRepository,
  UpdateToolJobStatusInput,
} from './domain/ports/tool-job.repository.js';

export type { ToolCancellationBus } from './domain/ports/supporting-ports.js';

export { RunningToolJobs } from './application/running-tool-jobs.js';
export { classifyToolFailure } from './application/tool-failure.js';
export type { ClassifiedToolFailure } from './application/tool-failure.js';
export { outputFileName } from './application/output-naming.js';
export type { OutputNameInput } from './application/output-naming.js';

export {
  TOOL_FAMILY_LABELS_FA,
  TOOL_LABELS_FA,
  faTools,
  toPersianDigits,
} from './presentation/telegram/messages/fa.js';

export {
  FAMILY_CALLBACK_CODES,
  TOOL_CALLBACK_CODES,
  familyFromCallbackCode,
  toolFromCallbackCode,
} from './presentation/telegram/callback-codes.js';

export {
  MenuAction,
  familyMenuKeyboard,
  toolMenuKeyboard,
} from './presentation/telegram/keyboards/menu.keyboard.js';
export type { EnabledFamilies } from './presentation/telegram/keyboards/menu.keyboard.js';

export {
  COMPRESS_TARGETS,
  RESIZE_DIMENSIONS,
  isOfferedChoice,
  isOptionDraftComplete,
  nextOptionStep,
  optionStepsFor,
} from './presentation/telegram/option-steps.js';
export type { ToolOptionChoice, ToolOptionStep } from './presentation/telegram/option-steps.js';

export { buildToolOperation } from './presentation/telegram/build-operation.js';
export type {
  BuildOperationFailure,
  BuildOperationResult,
  BuildOperationSuccess,
} from './presentation/telegram/build-operation.js';

export { RedisToolSessionStore } from './infrastructure/session/redis-tool-session-store.js';
export type { RedisToolSessionStoreOptions } from './infrastructure/session/redis-tool-session-store.js';

export {
  DrizzleToolJobEventRepository,
  DrizzleToolJobRepository,
} from './infrastructure/persistence/drizzle-tool-job.repository.js';
export {
  TOOL_CANCEL_CHANNEL,
  RedisToolCancellationBus,
} from './infrastructure/queue/redis-tool-cancellation-bus.js';
export type { RedisToolCancellationBusOptions } from './infrastructure/queue/redis-tool-cancellation-bus.js';
export { toToolInputReference, toToolJob } from './infrastructure/persistence/tool-row-mappers.js';

export { createToolsFeature } from './tools.feature.js';
export type { ToolsFeatureDeps } from './tools.feature.js';

export { RequestToolJobUseCase } from './application/request-tool-job.use-case.js';
export type {
  RequestToolJobDeps,
  RequestToolJobInput,
  RequestToolJobResult,
} from './application/request-tool-job.use-case.js';

export { BullMqToolQueue, QUEUE_FOR_FAMILY } from './infrastructure/queue/bullmq-tool-queue.js';
export type { ToolQueuePort } from './domain/ports/supporting-ports.js';
