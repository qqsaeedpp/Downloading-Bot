/**
 * The wire contracts for the file tools: what travels between the bot, Redis
 * and the tools worker.
 *
 * A package of its own rather than part of `@tgtools/shared` because these
 * carry Zod, and `shared` is deliberately dependency-free so that domain code
 * importing it stays framework-free. Everything here sits at a BOUNDARY —
 * session storage, queue payloads — which is exactly where runtime validation
 * belongs and where a schema library is worth its weight.
 */

export {
  TOOL_SESSION_SCHEMA_VERSION,
  parseToolSession,
  toolInputReferenceSchema,
  toolSessionKey,
  toolSessionSchema,
} from './session.js';
export type { ToolInputReference, ToolSession, ToolSessionState } from './session.js';

export {
  TOOL_JOB_SCHEMA_VERSION,
  expectedInputCount,
  parseToolJobPayload,
  toolJobPayload,
  toolJobPayloadSchema,
  toolOperationSchema,
} from './job-payload.js';
export type {
  ToolJobParseFailure,
  ToolJobParseSuccess,
  ToolJobPayload,
  ToolOperation,
} from './job-payload.js';
