import { ALL_TOOL_FAMILIES, ALL_TOOL_KEYS } from '@tgtools/shared';
import { CALLBACK_DATA_MAX_BYTES, CallbackNamespace, encodeCallback } from '@tgtools/telegram';
import { describe, expect, it } from 'vitest';
import {
  FAMILY_CALLBACK_CODES,
  TOOL_CALLBACK_CODES,
  familyFromCallbackCode,
  toolFromCallbackCode,
} from './callback-codes.js';

describe('the tool callback codes', () => {
  it('has a code for every tool, and decodes each one back', () => {
    // A tool with no code cannot be put on a button at all; a code that does
    // not decode produces a button that silently does nothing when tapped.
    for (const tool of ALL_TOOL_KEYS) {
      const code = TOOL_CALLBACK_CODES[tool];
      expect(code, tool).toBeTruthy();
      expect(toolFromCallbackCode(code), tool).toBe(tool);
    }
  });

  it('has a code for every family, and decodes each one back', () => {
    for (const family of ALL_TOOL_FAMILIES) {
      const code = FAMILY_CALLBACK_CODES[family];
      expect(familyFromCallbackCode(code), family).toBe(family);
    }
  });

  it('never gives two tools the same code', () => {
    // A collision routes one tool's button to another tool — and both would
    // still "work", which is why this is worth asserting rather than assuming.
    const codes = ALL_TOOL_KEYS.map((tool) => TOOL_CALLBACK_CODES[tool]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('does not confuse a family code with a tool code', () => {
    // They share the argument position in the wire format. `image` decoding as
    // both a family and a tool would make the router's order load-bearing.
    for (const family of ALL_TOOL_FAMILIES) {
      expect(toolFromCallbackCode(FAMILY_CALLBACK_CODES[family]), family).toBeUndefined();
    }
  });

  it('uses only characters the codec accepts', () => {
    // The codec refuses anything outside `[A-Za-z0-9_-]`, because a smuggled
    // separator would re-parse as an extra field and shift every following one.
    // Tool keys are dotted — `image.compress` — so they CANNOT be used raw, and
    // this is the whole reason the code table exists.
    for (const code of Object.values(TOOL_CALLBACK_CODES)) {
      expect(code, code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(code, code).not.toContain('.');
    }
  });

  it('leaves room in the 64-byte budget for a session handle beside it', () => {
    // The tightest real payload: a namespace, a version, an action, and an
    // 8-character short id. Encoding throws if it does not fit, so this proves
    // the codes are short enough to be USED, not merely to exist.
    for (const tool of ALL_TOOL_KEYS) {
      const data = encodeCallback(
        CallbackNamespace.ToolMenu,
        TOOL_CALLBACK_CODES[tool],
        'abcd1234',
      );
      expect(Buffer.byteLength(data, 'utf8'), tool).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
    }
  });

  it('returns undefined for anything it does not recognise', () => {
    // Every button ever sent stays clickable forever: a user can scroll back a
    // month and press one. Unknown codes are ordinary input, not exceptions.
    for (const unknown of ['', 'nope', 'IMGC', 'image.compress', '../..']) {
      expect(toolFromCallbackCode(unknown), unknown).toBeUndefined();
    }
  });
});
