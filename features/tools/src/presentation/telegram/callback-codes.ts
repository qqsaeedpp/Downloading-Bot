import type { ToolFamily, ToolKey } from '@tgtools/shared';

/**
 * Short codes standing in for tool and family names inside callback data.
 *
 * This table exists for one concrete reason: tool keys are DOTTED —
 * `image.compress` — and the callback codec refuses any argument outside
 * `[A-Za-z0-9_-]`. That restriction is not cosmetic; a separator smuggled into
 * an argument re-parses as an extra field and shifts every following one, which
 * is how a "cancel" button becomes a "confirm" button. So the key cannot travel
 * on a button as itself.
 *
 * The codes are also SHORT, which buys room in Telegram's 64-byte budget for
 * the session handle that has to sit beside them. Four characters rather than
 * fourteen is the difference between a menu that renders and one Telegram
 * silently refuses to send.
 *
 * Typed as total records, so a ninth tool without a code is a compile error
 * rather than a button that cannot be built at run time.
 */

export const TOOL_CALLBACK_CODES: Readonly<Record<ToolKey, string>> = {
  'image.compress': 'imgc',
  'image.resize': 'imgr',
  'image.convert': 'imgv',
  'video.extract_mp3': 'vidm',
  'video.remove_audio': 'vidn',
  'pdf.images_to_pdf': 'pdfb',
  'pdf.to_images': 'pdfi',
  'qr.generate': 'qrg',
};

/**
 * Deliberately NOT the bare family names.
 *
 * A family code and a tool code share the argument position in the wire format,
 * so overlapping values would make the router's matching order load-bearing —
 * and a reordering months later would silently send one menu's taps to another.
 */
export const FAMILY_CALLBACK_CODES: Readonly<Record<ToolFamily, string>> = {
  image: 'fimg',
  video: 'fvid',
  pdf: 'fpdf',
  qr: 'fqr',
};

const TOOL_BY_CODE: ReadonlyMap<string, ToolKey> = new Map(
  Object.entries(TOOL_CALLBACK_CODES).map(([tool, code]) => [code, tool as ToolKey]),
);

const FAMILY_BY_CODE: ReadonlyMap<string, ToolFamily> = new Map(
  Object.entries(FAMILY_CALLBACK_CODES).map(([family, code]) => [code, family as ToolFamily]),
);

/**
 * Returns `undefined` for anything unrecognised rather than throwing.
 *
 * Every button ever sent stays clickable forever — a user can scroll back a
 * month and press one — so a stale or hand-made code is ordinary input.
 */
export function toolFromCallbackCode(code: string): ToolKey | undefined {
  return TOOL_BY_CODE.get(code);
}

export function familyFromCallbackCode(code: string): ToolFamily | undefined {
  return FAMILY_BY_CODE.get(code);
}
