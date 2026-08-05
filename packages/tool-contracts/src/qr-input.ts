import { z } from 'zod';

/**
 * What a QR code should say, as STRUCTURE rather than as a finished string.
 *
 * The alternative — having the bot build and escape the payload and send a
 * string — was rejected for two reasons, one architectural and one about
 * validation.
 *
 * The architectural one: `buildQrPayload` lives in `@tgtools/file-tools-engine`,
 * whose entry point loads Sharp's native binding. The bot process never decodes
 * a pixel, and making it link libvips in order to escape a semicolon would put a
 * 40 MB native dependency into the one process that must stay responsive to
 * every user's keystrokes. `NodeQrGenerator.generate` already takes this shape
 * and calls the builder itself, so the string was being assembled a layer too
 * early anyway.
 *
 * The validation one: a pre-built string can only be checked for "not empty".
 * Structure can be checked for what actually makes a code unusable — a latitude
 * of 91, an SSID of three spaces, a security mode no builder can express — at
 * the boundary, before the job is persisted and queued, rather than several
 * seconds and one dequeue later.
 *
 * NOTHING here may be written to the database. See `toStorableOperation`.
 */

export const QR_CONTENT_KIND_VALUES = [
  'text',
  'url',
  'wifi',
  'phone',
  'email',
  'geo',
  'vcard',
] as const;
export type QrContentKind = (typeof QR_CONTENT_KIND_VALUES)[number];

/**
 * Ceilings on the free-text fields.
 *
 * Deliberately loose. The ceiling that decides whether a code is readable is
 * counted in BYTES against the chosen error-correction level, and it belongs in
 * the engine where the encoder is; this only exists so a megabyte of text cannot
 * sit in a Redis payload for the several seconds it would take to be rejected.
 */
const TEXT_MAX = 4_096;
const URL_MAX = 4_096;

/**
 * WPA3 is absent because the `WIFI:` scheme has no code for it — a WPA3 network
 * is provisioned as `WPA` and every current handset accepts that. Offering the
 * value would produce codes that scan and then fail to connect.
 */
export const QR_WIFI_SECURITY_VALUES = ['WPA', 'WEP', 'nopass'] as const;
export type QrWifiSecurity = (typeof QR_WIFI_SECURITY_VALUES)[number];

/** Trimmed to non-empty: a value of three spaces satisfies `min(1)` and names nothing. */
const nonBlank = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() !== '', { message: 'must not be blank' });

/**
 * Zod 4's `z.number()` already refuses NaN and the infinities, so no `.finite()`
 * is needed — but the suite asserts it anyway, because the consequence of that
 * default changing back is silent: `JSON.stringify(NaN)` is `null`, so a NaN
 * accepted here would reach the worker as a MISSING field and fail its re-parse
 * complaining about the wrong problem entirely.
 */
const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

export const qrContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: nonBlank(TEXT_MAX) }),
  z.object({ kind: z.literal('url'), url: nonBlank(URL_MAX) }),
  z.object({
    kind: z.literal('wifi'),
    // 32 bytes is the 802.11 maximum; the extra room is for the multi-byte
    // characters an SSID may legally contain.
    ssid: nonBlank(64),
    // WPA passphrases run to 63 characters, or 64 hex digits for a raw PSK.
    password: z.string().min(1).max(128).optional(),
    security: z.enum(QR_WIFI_SECURITY_VALUES),
    hidden: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('phone'), phone: nonBlank(32) }),
  // 254 is the RFC 5321 ceiling on a whole address.
  z.object({ kind: z.literal('email'), email: nonBlank(254) }),
  z.object({ kind: z.literal('geo'), latitude, longitude }),
  z.object({
    kind: z.literal('vcard'),
    name: nonBlank(128),
    phone: nonBlank(32),
    email: z.string().min(1).max(254).optional(),
  }),
]);

/**
 * Structurally identical to the engine's `QrInput`, and kept that way by a
 * compile-time assignability check in the engine's own test suite — the two
 * drifting apart is exactly the kind of break that type-checks in both packages
 * and fails at the one call site that joins them.
 */
export type QrContent = z.infer<typeof qrContentSchema>;
