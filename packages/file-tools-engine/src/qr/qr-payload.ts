import { ToolError, ToolErrorCode } from '../errors/tool-error.js';

/**
 * Turning what a user typed into the string a QR scanner understands.
 *
 * Pure, and separate from the encoder, because the interesting part is the
 * ESCAPING. A Wi-Fi password containing a semicolon written straight into the
 * payload terminates the field early, and the resulting code either fails to
 * connect or — worse — joins a network with a truncated password and no
 * explanation. Testing that against a real PNG would prove nothing; testing the
 * string proves everything.
 */

export const QR_KIND_VALUES = ['text', 'url', 'wifi', 'phone', 'email', 'geo', 'vcard'] as const;
export type QrKind = (typeof QR_KIND_VALUES)[number];

export function isQrKind(value: string): value is QrKind {
  return (QR_KIND_VALUES as readonly string[]).includes(value);
}

export const WIFI_SECURITY_VALUES = ['WPA', 'WEP', 'nopass'] as const;
export type WifiSecurity = (typeof WIFI_SECURITY_VALUES)[number];

export type QrInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'url'; readonly url: string }
  | {
      readonly kind: 'wifi';
      readonly ssid: string;
      readonly password?: string | undefined;
      readonly security: WifiSecurity;
      readonly hidden?: boolean;
    }
  | { readonly kind: 'phone'; readonly phone: string }
  | { readonly kind: 'email'; readonly email: string }
  | { readonly kind: 'geo'; readonly latitude: number; readonly longitude: number }
  | {
      readonly kind: 'vcard';
      readonly name: string;
      readonly phone: string;
      readonly email?: string | undefined;
    };

/**
 * Escape a value for the `WIFI:` scheme.
 *
 * Backslash first, always. Escaping the separators before the escape character
 * itself would double-escape the backslashes the earlier passes introduced,
 * corrupting any password that legitimately contains one.
 */
export function escapeWifiValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/:/g, '\\:')
    .replace(/"/g, '\\"');
}

/**
 * Give a bare hostname a scheme.
 *
 * `example.com` scanned without one is treated as text by most readers, so the
 * user gets a QR code that displays a string instead of opening a page. HTTPS
 * rather than HTTP because defaulting to plaintext in 2026 is indefensible.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Keeps digits and a single leading `+`; everything else is presentation. */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/**
 * Build the payload string.
 *
 * Throws only for input a scanner could not act on at all — an empty SSID, a
 * latitude off the globe. Anything merely unusual is passed through, because a
 * QR code is a transport and second-guessing its contents is not this layer's
 * job.
 */
export function buildQrPayload(input: QrInput): string {
  switch (input.kind) {
    case 'text':
      return input.text;

    case 'url':
      return normalizeUrl(input.url);

    case 'wifi': {
      if (input.ssid.trim() === '') {
        throw new ToolError(ToolErrorCode.InternalError, 'Wi-Fi QR needs an SSID');
      }
      const parts = [
        `T:${input.security}`,
        `S:${escapeWifiValue(input.ssid)}`,
        // An open network carries no password field at all. An empty one makes
        // some Android builds prompt for a key that does not exist.
        ...(input.security === 'nopass' || input.password === undefined || input.password === ''
          ? []
          : [`P:${escapeWifiValue(input.password)}`]),
        ...(input.hidden === true ? ['H:true'] : []),
      ];
      return `WIFI:${parts.join(';')};;`;
    }

    case 'phone':
      return `tel:${normalizePhone(input.phone)}`;

    case 'email':
      return `mailto:${input.email.trim()}`;

    case 'geo': {
      if (
        !Number.isFinite(input.latitude) ||
        !Number.isFinite(input.longitude) ||
        Math.abs(input.latitude) > 90 ||
        Math.abs(input.longitude) > 180
      ) {
        throw new ToolError(ToolErrorCode.InternalError, 'coordinates are outside the globe');
      }
      return `geo:${String(input.latitude)},${String(input.longitude)}`;
    }

    case 'vcard': {
      // CRLF, not LF. The vCard grammar requires it, and several iOS versions
      // silently refuse a card that uses bare newlines.
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeVCardValue(input.name)}`,
        `TEL:${normalizePhone(input.phone)}`,
        ...(input.email === undefined || input.email === ''
          ? []
          : [`EMAIL:${escapeVCardValue(input.email)}`]),
        'END:VCARD',
      ];
      return lines.join('\r\n');
    }
  }
}

/** vCard uses its own escape set, and a stray newline ends the property. */
function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Refuse a payload no scanner could read back.
 *
 * Measured in BYTES: a QR code stores bytes, and Persian text is two to three
 * of them per character, so a limit counted in characters would accept a string
 * three times larger than the format allows and fail inside the encoder with a
 * message about version overflow.
 */
export function assertPayloadFits(payload: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes === 0) {
    throw new ToolError(ToolErrorCode.InternalError, 'refusing to encode an empty QR payload');
  }
  if (bytes > maxBytes) {
    throw new ToolError(ToolErrorCode.QrInputTooLong, 'QR payload is longer than the ceiling', {
      // Deliberately no payload here. It can be a password or a Wi-Fi key, and
      // an error object ends up in logs.
      context: { bytes, maxBytes },
    });
  }
}
