import { TOOL_KEY_VALUES } from '@tgtools/shared';
import { z } from 'zod';
import { qrContentSchema } from './qr-input.js';
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
     * What the code should say, STRUCTURED — see `qr-input.ts` for why it is not
     * a finished string.
     *
     * Named `content` rather than `input` so it cannot be confused with the
     * `inputs` array below, which is files. QR takes no file at all.
     *
     * Deliberately secret: it can be a Wi-Fi password, a private URL or a home
     * address, so it is never persisted to the job row and never logged. It
     * exists in the queue for as long as the job takes and nowhere else.
     */
    content: qrContentSchema,
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
 * The form of an operation that may be written to `tool_jobs.operation_payload`.
 *
 * That column is an audit record with no expiry: it outlives the job, the chat
 * and — for a Wi-Fi key — very probably the network. Every tool but QR carries
 * only dimensions, formats and quality settings, which are exactly what the row
 * exists to remember. QR carries whatever the user typed.
 *
 * So QR is reduced to an ALLOW-LIST of its four non-content fields rather than
 * having its content deleted. The difference matters the day someone adds a
 * field to the vCard arm: with a deny-list it would silently start being
 * persisted, and with this the failure mode of forgetting is a missing column
 * value rather than a disclosed one.
 */
export function toStorableOperation(operation: ToolOperation): Readonly<Record<string, unknown>> {
  if (operation.tool === 'qr.generate') {
    return {
      tool: operation.tool,
      // The KIND is not itself a secret, and without it the row cannot answer
      // "what did this job do" — which is the whole point of keeping it.
      kind: operation.content.kind,
      format: operation.format,
      size: operation.size,
      errorCorrection: operation.errorCorrection,
    };
  }
  return { ...operation };
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
