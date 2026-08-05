/**
 * The file-processing engine: Sharp, FFmpeg, Poppler, PDFKit and qrcode behind
 * plain interfaces.
 *
 * Nothing here knows about Telegram, BullMQ, Postgres or Persian. It takes
 * paths and options and produces files, which is what makes every rule in it
 * testable without a bot, a queue or a network.
 */

export {
  ToolError,
  ToolErrorCode,
  isRetryableToolError,
  isToolError,
  toToolError,
} from './errors/tool-error.js';
export type { ToolErrorOptions } from './errors/tool-error.js';

export { runProcess, runProcessOrThrow } from './process/child-process-runner.js';
export type { ProcessRunOptions, ProcessRunResult } from './process/child-process-runner.js';

export { ToolWorkspaceManager, assertNotSymlinked } from './workspace/tool-workspace.js';
export type { ToolWorkspace, WorkspaceManagerOptions } from './workspace/tool-workspace.js';
