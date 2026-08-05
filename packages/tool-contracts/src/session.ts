import { TOOL_KEY_VALUES } from '@tgtools/shared';
import { z } from 'zod';

/**
 * The conversation state of one user's tool operation.
 *
 * Kept in Redis rather than in the bot's memory for a reason that shows up the
 * first time a deployment rolls: a user halfway through "send me your photos"
 * would otherwise find the bot had forgotten them, with no message and no way
 * to recover except starting over. It also stops two bot replicas disagreeing
 * about what the user is doing.
 *
 * Every variant carries `schemaVersion`. A session written by the previous
 * release and read by this one is routine during a rolling deploy, and the only
 * safe response to a shape we no longer understand is to discard it — which
 * first requires being able to tell it apart from a corrupt value.
 */

export const TOOL_SESSION_SCHEMA_VERSION = 1;

/**
 * What the bot remembers about a file the user sent.
 *
 * Deliberately only the Telegram reference. No path, no URL, no token: the
 * worker resolves the file itself at the moment it needs it, so nothing that
 * could leak a credential is ever written to Redis or to a queue.
 */
export const toolInputReferenceSchema = z.object({
  fileId: z.string().min(1),
  fileUniqueId: z.string().min(1),
  declaredSize: z.number().int().nonnegative().optional(),
  declaredMimeType: z.string().min(1).optional(),
  /**
   * Shown back to the user, or used to pick an extension — never used to build
   * a path. A filename is attacker-controlled input.
   */
  originalName: z.string().min(1).optional(),
  /** Preserves album order, which arrives as several independent updates. */
  receivedAtMs: z.number().int().nonnegative(),
});
export type ToolInputReference = z.infer<typeof toolInputReferenceSchema>;

const base = {
  schemaVersion: z.literal(TOOL_SESSION_SCHEMA_VERSION),
  tool: z.enum(TOOL_KEY_VALUES),
  createdAtMs: z.number().int().nonnegative(),
};

/**
 * The states, as a discriminated union rather than a state string beside a bag
 * of optional fields.
 *
 * The difference shows at the call site: `awaiting_options` is guaranteed to
 * have inputs and the compiler enforces it, so a handler cannot read files that
 * have not been collected yet.
 */
export const toolSessionSchema = z.discriminatedUnion('state', [
  z.object({ ...base, state: z.literal('awaiting_input') }),
  z.object({
    ...base,
    state: z.literal('collecting_inputs'),
    inputs: z.array(toolInputReferenceSchema).min(1),
    /** Set while an album is still arriving, so the reply can be debounced. */
    pendingMediaGroupId: z.string().min(1).optional(),
  }),
  z.object({
    ...base,
    state: z.literal('awaiting_options'),
    inputs: z.array(toolInputReferenceSchema).min(1),
    /**
     * Whatever the flow has gathered so far. Unknown at this layer on purpose:
     * each tool owns its option schema and validates it before the job is
     * built, and restating those shapes here would be two definitions to keep
     * in step.
     */
    draftOptions: z.record(z.string(), z.unknown()).default({}),
    step: z.string().min(1),
  }),
  z.object({
    ...base,
    state: z.literal('ready_for_confirmation'),
    inputs: z.array(toolInputReferenceSchema).min(1),
    options: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...base,
    state: z.literal('queued'),
    jobId: z.string().min(1),
    shortId: z.string().min(1),
  }),
]);
export type ToolSession = z.infer<typeof toolSessionSchema>;
export type ToolSessionState = ToolSession['state'];

/**
 * Parse a stored session, returning `undefined` for anything unusable.
 *
 * Never throws. A session that fails to parse — written by an older release,
 * truncated, hand-edited — is indistinguishable from no session at all as far
 * as the user's next action goes, and raising here would fail their message
 * instead of quietly restarting the flow.
 */
export function parseToolSession(raw: string | null | undefined): ToolSession | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = toolSessionSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Redis key for one user's session.
 *
 * Scoped by bot id as well as user id: two tokens sharing a Redis — a staging
 * bot beside production, which is how this is usually deployed — must not share
 * conversation state.
 */
export function toolSessionKey(botId: string, telegramUserId: number): string {
  return `tool-session:${botId}:${String(telegramUserId)}`;
}
