import type { ToolKey } from '@tgtools/shared';
import { toolOperationSchema } from '@tgtools/tool-contracts';
import type { QrContent, ToolOperation } from '@tgtools/tool-contracts';
import { COMPRESS_TARGETS, RESIZE_DIMENSIONS } from './option-steps.js';

/**
 * Turning the answers a user tapped into the operation that travels on the
 * queue.
 *
 * The last line of every path is the same: the assembled object goes through
 * `toolOperationSchema`. Nothing here trusts its own assembly — the draft is
 * built from callback data, which anyone can send, and a hand-made payload that
 * slipped past the choice check would otherwise reach the worker as a
 * structurally valid job with nonsense in it.
 *
 * Returning a result rather than throwing because a draft that cannot be built
 * is a USER-visible outcome — "start again" — not an exception.
 */

export interface BuildOperationSuccess {
  readonly ok: true;
  readonly operation: ToolOperation;
}

export interface BuildOperationFailure {
  readonly ok: false;
  readonly reason: string;
}

export type BuildOperationResult = BuildOperationSuccess | BuildOperationFailure;

function fail(reason: string): BuildOperationFailure {
  return { ok: false, reason };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Split what the user typed for a QR code into the structured content the
 * contract carries.
 *
 * Wi-Fi and vCard need more than one value, and asking three separate questions
 * for a Wi-Fi network would mean three round trips and three chances to abandon
 * the flow. A single line with `|` separators is what a person can actually
 * type on a phone.
 */
function buildQrContent(kind: string, body: string): QrContent | undefined {
  const parts = body.split('|').map((part) => part.trim());
  const first = parts[0] ?? '';

  switch (kind) {
    case 'text':
      return { kind: 'text', text: body };
    case 'url':
      return { kind: 'url', url: first };
    case 'phone':
      return { kind: 'phone', phone: first };
    case 'email':
      return { kind: 'email', email: first };
    case 'wifi': {
      const [ssid, password, security] = parts;
      if (ssid === undefined || ssid === '') return undefined;
      // An open network is spelled by leaving the password out, and the
      // contract refuses an empty string — so the field is omitted rather than
      // set to ''.
      const mode =
        security === 'WEP' ? 'WEP' : password === undefined || password === '' ? 'nopass' : 'WPA';
      return {
        kind: 'wifi',
        ssid,
        security: mode,
        ...(password === undefined || password === '' ? {} : { password }),
      };
    }
    case 'geo': {
      const [latitude, longitude] = parts;
      if (latitude === undefined || longitude === undefined) return undefined;
      const lat = Number(latitude);
      const lon = Number(longitude);
      // `Number('')` is 0, which would silently place the user in the Gulf of
      // Guinea rather than reporting that they typed nothing.
      if (latitude === '' || longitude === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
        return undefined;
      }
      return { kind: 'geo', latitude: lat, longitude: lon };
    }
    case 'vcard': {
      const [name, phone, email] = parts;
      if (name === undefined || name === '' || phone === undefined || phone === '')
        return undefined;
      return {
        kind: 'vcard',
        name,
        phone,
        ...(email === undefined || email === '' ? {} : { email }),
      };
    }
    default:
      return undefined;
  }
}

/** Defaults for the QR settings not worth a question of their own. */
const QR_DEFAULT_SIZE = 512;
/** `M` (~15%) is what most printed codes use and leaves the most room for content. */
const QR_DEFAULT_ERROR_CORRECTION = 'M';

export function buildToolOperation(
  tool: ToolKey,
  draft: Readonly<Record<string, unknown>>,
): BuildOperationResult {
  const assembled = assemble(tool, draft);
  if (assembled === undefined) return fail(`the answers for "${tool}" are incomplete`);

  // The single gate every path passes through.
  const parsed = toolOperationSchema.safeParse(assembled);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue === undefined ? 'the options did not validate' : issue.message);
  }
  return { ok: true, operation: parsed.data };
}

function assemble(tool: ToolKey, draft: Readonly<Record<string, unknown>>): unknown {
  switch (tool) {
    case 'image.compress': {
      const level = asString(draft.lvl);
      const target = asString(draft.tgt);
      if (level === undefined || target === undefined) return undefined;
      const targetBytes = COMPRESS_TARGETS[target];
      return {
        tool,
        level,
        ...(targetBytes === undefined ? {} : { targetBytes }),
      };
    }

    case 'image.resize': {
      const preset = asString(draft.sz);
      if (preset === undefined) return undefined;
      const dimensions = RESIZE_DIMENSIONS[preset];
      if (dimensions === undefined) return undefined;
      return {
        tool,
        width: dimensions.width,
        ...(dimensions.height === undefined ? {} : { height: dimensions.height }),
        fit: dimensions.fit,
      };
    }

    case 'image.convert': {
      const format = asString(draft.fmt);
      return format === undefined ? undefined : { tool, format };
    }

    case 'video.extract_mp3': {
      const quality = asString(draft.q);
      return quality === undefined ? undefined : { tool, quality };
    }

    case 'video.remove_audio':
      // No options at all, so nothing to read out of the draft.
      return { tool };

    case 'pdf.images_to_pdf': {
      const mode = asString(draft.mode);
      return mode === undefined ? undefined : { tool, mode };
    }

    case 'pdf.to_images': {
      const format = asString(draft.fmt);
      const dpi = asString(draft.dpi);
      if (format === undefined || dpi === undefined) return undefined;
      return { tool, format, dpi: Number(dpi) };
    }

    case 'qr.generate': {
      const kind = asString(draft.kind);
      const body = asString(draft.body);
      const format = asString(draft.fmt);
      if (kind === undefined || body === undefined || format === undefined) return undefined;

      const content = buildQrContent(kind, body);
      if (content === undefined) return undefined;

      return {
        tool,
        content,
        format,
        size: QR_DEFAULT_SIZE,
        errorCorrection: QR_DEFAULT_ERROR_CORRECTION,
      };
    }
  }
}
