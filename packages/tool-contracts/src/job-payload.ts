import { TOOL_KEY_VALUES } from '@tgtools/shared';
import { z } from 'zod';
import { toolInputReferenceSchema } from './session.js';

/**
 * What travels from the bot to the tools worker.
 *
 * Validated on BOTH sides. The bot builds it from a session it already trusts,
 * and the worker re-parses it on receipt — because a queue outlives a
 * deployment, and a job enqueued by the previous release is the normal case
 * during a rolling restart, not an exotic one.
 *
 * Carries no secret, no path and no URL. The worker resolves each file from its
 * Telegram reference when it runs, which is what keeps a bot token out of Redis.
 */

export const TOOL_JOB_SCHEMA_VERSION = 1;

/** Where a `contain` fit puts the empty space. */
const backgroundSchema = z.enum(['white', 'black', 'transparent']);

/**
 * Per-tool options, discriminated by the tool key.
 *
 * A discriminated union rather than a loose record because the worker switches
 * on `tool` and must be able to read the options for that arm without checking
 * whether each field happens to be present. A `Record<string, unknown>` here
 * would push that checking into every processor.
 */
export const toolOperationSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('image.compress'),
    level: z.enum(['high', 'balanced', 'maximum']),
    /** Set only when the user asked for a specific size. */
    targetBytes: z.number().int().positive().optional(),
  }),
  z.object({
    tool: z.literal('image.resize'),
    width: z.number().int().min(1).max(12_000),
    height: z.number().int().min(1).max(12_000).optional(),
    fit: z.enum(['cover', 'contain', 'inside']),
    background: backgroundSchema.optional(),
    allowUpscale: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal('image.convert'),
    format: z.enum(['jpeg', 'png', 'webp', 'avif']),
    background: z.enum(['white', 'black']).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    lossless: z.boolean().optional(),
  }),
  z.object({
    tool: z.literal('video.extract_mp3'),
    quality: z.enum(['128', '192', '320', 'vbr']),
  }),
  z.object({
    tool: z.literal('video.remove_audio'),
  }),
  z.object({
    tool: z.literal('pdf.images_to_pdf'),
    mode: z.enum(['image', 'a4-contain', 'a4-cover']),
    marginPoints: z.number().int().min(0).max(200).optional(),
  }),
  z.object({
    tool: z.literal('pdf.to_images'),
    format: z.enum(['png', 'jpeg']),
    dpi: z.number().int().min(36).max(600),
    firstPage: z.number().int().min(1).optional(),
    lastPage: z.number().int().min(1).optional(),
  }),
  z.object({
    tool: z.literal('qr.generate'),
    /**
     * The payload STRING, already built and escaped by the bot.
     *
     * Deliberately opaque here: it can be a Wi-Fi password or a private URL, so
     * it is never persisted to the job row and never logged. It exists in the
     * queue for as long as the job takes and nowhere else.
     */
    payload: z.string().min(1),
    format: z.enum(['png', 'svg']),
    size: z.number().int().min(128).max(2_048),
    errorCorrection: z.enum(['M', 'Q', 'H']),
  }),
]);
export type ToolOperation = z.infer<typeof toolOperationSchema>;

export const toolJobPayloadSchema = z.object({
  schemaVersion: z.literal(TOOL_JOB_SCHEMA_VERSION),
  jobId: z.string().min(1),
  /** Short handle used in the cancel button; see the callback codec. */
  shortId: z.string().min(1),
  requestId: z.string().min(1),

  telegram: z.object({
    userId: z.number().int(),
    chatId: z.number().int(),
    statusMessageId: z.number().int(),
  }),

  /**
   * Duplicated from `operation.tool` on purpose.
   *
   * The worker has to pick a queue and a set of ceilings before it parses the
   * operation, and reading the discriminator out of a union means parsing the
   * union first. One redundant field is cheaper than that ordering constraint;
   * the schema below refuses a payload where the two disagree.
   */
  tool: z.enum(TOOL_KEY_VALUES),
  operation: toolOperationSchema,

  inputs: z.array(toolInputReferenceSchema),
});

/**
 * The schema plus the cross-field rule the object schema cannot express.
 *
 * A payload whose `tool` and `operation.tool` disagree is not merely odd — it
 * would be queued as one kind of work and executed as another.
 */
export const toolJobPayload = toolJobPayloadSchema.refine(
  (payload) => payload.tool === payload.operation.tool,
  { message: '`tool` and `operation.tool` disagree', path: ['tool'] },
);

export type ToolJobPayload = z.infer<typeof toolJobPayloadSchema>;

export interface ToolJobParseFailure {
  readonly ok: false;
  readonly reason: string;
}

export interface ToolJobParseSuccess {
  readonly ok: true;
  readonly payload: ToolJobPayload;
}

/**
 * Parse a payload off the queue.
 *
 * Returns a result rather than throwing so the worker can distinguish "this job
 * is malformed and must NOT be retried" from a transient failure. Retrying a
 * payload the schema rejects burns the attempt budget to reach the same answer.
 */
export function parseToolJobPayload(value: unknown): ToolJobParseSuccess | ToolJobParseFailure {
  const result = toolJobPayload.safeParse(value);
  if (result.success) return { ok: true, payload: result.data };
  const first = result.error.issues[0];
  return {
    ok: false,
    reason:
      first === undefined
        ? 'payload did not match the schema'
        : `${first.path.join('.')}: ${first.message}`,
  };
}

/**
 * How many inputs each tool expects.
 *
 * Checked before the job is queued AND on receipt: "images to PDF" is the only
 * tool that takes several, and every other one silently ignoring extras would
 * mean a user who sent three photos gets one back with no explanation.
 */
export function expectedInputCount(tool: ToolJobPayload['tool']): { min: number; max: number } {
  if (tool === 'pdf.images_to_pdf') return { min: 1, max: 50 };
  if (tool === 'qr.generate') return { min: 0, max: 0 };
  return { min: 1, max: 1 };
}
