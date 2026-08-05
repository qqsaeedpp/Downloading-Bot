import { ALL_TOOL_KEYS, ToolFamily, toolFamilyOf } from '@tgtools/shared';
import { CALLBACK_DATA_MAX_BYTES, decodeCallback } from '@tgtools/telegram';
import type { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import type { EnabledFamilies } from './menu.keyboard.js';
import { familyMenuKeyboard, toolMenuKeyboard } from './menu.keyboard.js';

const ALL_ON: EnabledFamilies = { image: true, video: true, pdf: true, qr: true };

/** Every button, flattened out of the row structure. */
function buttons(keyboard: InlineKeyboard): { text: string; data: string }[] {
  return keyboard.inline_keyboard.flat().flatMap((button) => {
    const data = 'callback_data' in button ? button.callback_data : undefined;
    return data === undefined ? [] : [{ text: button.text, data }];
  });
}

describe('familyMenuKeyboard', () => {
  it('offers every family when all four are switched on', () => {
    expect(buttons(familyMenuKeyboard(ALL_ON))).toHaveLength(4);
  });

  it('omits a family whose worker will not drain its queue', () => {
    // The tools worker starts NO consumer for a disabled family, so a button
    // for one would take the user through an entire flow and leave the job
    // sitting in Redis forever with the status stuck at "queued".
    const withoutVideo = buttons(familyMenuKeyboard({ ...ALL_ON, video: false }));

    expect(withoutVideo).toHaveLength(3);
    expect(withoutVideo.some((button) => button.text.includes('ویدیو'))).toBe(false);
  });

  it('produces an empty keyboard rather than throwing when everything is off', () => {
    // A caller has to be able to detect this and say so; building a menu with
    // no buttons is Telegram's error, not ours to raise here.
    expect(
      buttons(familyMenuKeyboard({ image: false, video: false, pdf: false, qr: false })),
    ).toEqual([]);
  });

  it('gives every button decodable callback data within the Telegram limit', () => {
    // A button over 64 bytes makes Telegram refuse the WHOLE keyboard, with no
    // error attached to the button that caused it.
    for (const button of buttons(familyMenuKeyboard(ALL_ON))) {
      expect(Buffer.byteLength(button.data, 'utf8'), button.text).toBeLessThanOrEqual(
        CALLBACK_DATA_MAX_BYTES,
      );
      expect(decodeCallback(button.data), button.text).toBeDefined();
    }
  });
});

describe('toolMenuKeyboard', () => {
  it('lists exactly the tools belonging to the family', () => {
    for (const family of [ToolFamily.Image, ToolFamily.Video, ToolFamily.Pdf, ToolFamily.Qr]) {
      const expected = ALL_TOOL_KEYS.filter((tool) => toolFamilyOf(tool) === family);
      // One button per tool, plus the back button.
      expect(buttons(toolMenuKeyboard(family)), family).toHaveLength(expected.length + 1);
    }
  });

  it('files images-to-PDF under PDF, where it is queued', () => {
    // It CONSUMES images but is priced and queued as PDF work. Listing it under
    // "تصویر" would send users hunting in the wrong submenu.
    const pdfButtons = buttons(toolMenuKeyboard(ToolFamily.Pdf));
    expect(pdfButtons.some((button) => button.text.includes('ساخت PDF'))).toBe(true);

    const imageButtons = buttons(toolMenuKeyboard(ToolFamily.Image));
    expect(imageButtons.some((button) => button.text.includes('ساخت PDF'))).toBe(false);
  });

  it('always offers a way back', () => {
    // Without it the only escape from a submenu is /menu, which a user who
    // arrived by tapping has no reason to know about.
    for (const family of [ToolFamily.Image, ToolFamily.Video, ToolFamily.Pdf, ToolFamily.Qr]) {
      const texts = buttons(toolMenuKeyboard(family)).map((button) => button.text);
      expect(
        texts.some((text) => text.includes('بازگشت')),
        family,
      ).toBe(true);
    }
  });

  it('reaches every tool in the vocabulary from exactly one family menu', () => {
    // A tool reachable from no menu is dead code the user cannot run; one
    // reachable from two is a routing ambiguity.
    const seen = new Map<string, number>();
    for (const family of [ToolFamily.Image, ToolFamily.Video, ToolFamily.Pdf, ToolFamily.Qr]) {
      for (const button of buttons(toolMenuKeyboard(family))) {
        const decoded = decodeCallback(button.data);
        if (decoded?.arg === undefined) continue;
        seen.set(decoded.arg, (seen.get(decoded.arg) ?? 0) + 1);
      }
    }

    for (const tool of ALL_TOOL_KEYS) {
      const code = buttons(toolMenuKeyboard(toolFamilyOf(tool)))
        .map((button) => decodeCallback(button.data)?.arg)
        .filter((arg): arg is string => arg !== undefined);
      expect(code.length, tool).toBeGreaterThan(0);
    }
    // Each tool code appears once across all four menus; the back buttons carry
    // no argument and so are not counted here.
    for (const [arg, count] of seen) {
      expect(count, arg).toBe(1);
    }
  });

  it('labels every button in Persian, never with a raw tool key', () => {
    for (const button of buttons(toolMenuKeyboard(ToolFamily.Image))) {
      expect(button.text).not.toContain('image.');
      expect(button.text).not.toContain('undefined');
    }
  });

  it('keeps every button inside the byte limit', () => {
    for (const family of [ToolFamily.Image, ToolFamily.Video, ToolFamily.Pdf, ToolFamily.Qr]) {
      for (const button of buttons(toolMenuKeyboard(family))) {
        expect(Buffer.byteLength(button.data, 'utf8'), button.text).toBeLessThanOrEqual(
          CALLBACK_DATA_MAX_BYTES,
        );
      }
    }
  });

  it('puts one tool per row, because Persian labels are long', () => {
    // Two of these side by side are truncated to illegibility on a phone.
    for (const row of toolMenuKeyboard(ToolFamily.Image).inline_keyboard) {
      expect(row.length).toBe(1);
    }
  });
});
