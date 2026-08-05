import type { ToolFamily } from '@tgtools/shared';
import { ALL_TOOL_FAMILIES, ALL_TOOL_KEYS, toolFamilyOf } from '@tgtools/shared';
import { CallbackNamespace, encodeCallback } from '@tgtools/telegram';
import { InlineKeyboard } from 'grammy';
import { FAMILY_CALLBACK_CODES, TOOL_CALLBACK_CODES } from '../callback-codes.js';
import { TOOL_FAMILY_LABELS_FA, TOOL_LABELS_FA, faTools } from '../messages/fa.js';

/**
 * The two menus a user navigates: pick a family, then pick a tool.
 *
 * Two levels rather than one flat list of eight because the list is going to
 * grow, and because the families already mean something real — they select the
 * queue, the concurrency and the ceilings. A menu that mirrors the architecture
 * is one fewer thing to keep in step.
 *
 * Everything here is pure. A keyboard is a value, and building it without a
 * grammy context is what lets the byte limit, the family filtering and the
 * back-button rule all be asserted in the unit suite.
 */

/** Which families this deployment is actually running. */
export interface EnabledFamilies {
  readonly image: boolean;
  readonly video: boolean;
  readonly pdf: boolean;
  readonly qr: boolean;
}

/** Actions carried in the `tm` namespace. Short, because they share the 64-byte budget. */
export const MenuAction = {
  /** Open a family's tool list. The argument is a family code. */
  OpenFamily: 'f',
  /** Start a tool's flow. The argument is a tool code. */
  PickTool: 't',
  /** Back to the family menu. Carries no argument. */
  Root: 'r',
} as const;

/**
 * The root menu, filtered to what will actually run.
 *
 * A disabled family is OMITTED rather than shown and refused. The tools worker
 * starts no consumer for one, so a button would walk the user through the whole
 * flow — upload, options, confirm — and leave the job sitting in Redis with the
 * status stuck at "queued" and nothing ever to pick it up.
 */
export function familyMenuKeyboard(enabled: EnabledFamilies): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const family of ALL_TOOL_FAMILIES) {
    if (!enabled[family]) continue;
    keyboard
      .text(
        TOOL_FAMILY_LABELS_FA[family],
        encodeCallback(
          CallbackNamespace.ToolMenu,
          MenuAction.OpenFamily,
          FAMILY_CALLBACK_CODES[family],
        ),
      )
      .row();
  }

  return keyboard;
}

/**
 * One family's tools, one per row.
 *
 * One per row is a layout decision with a reason: the Persian labels run to
 * twenty-odd characters, and two side by side are truncated to illegibility on
 * a phone.
 */
export function toolMenuKeyboard(family: ToolFamily): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Derived from the vocabulary rather than listed per family, so a ninth tool
  // appears in its menu automatically — and cannot be added to the wrong one.
  for (const tool of ALL_TOOL_KEYS) {
    if (toolFamilyOf(tool) !== family) continue;
    keyboard
      .text(
        TOOL_LABELS_FA[tool],
        encodeCallback(CallbackNamespace.ToolMenu, MenuAction.PickTool, TOOL_CALLBACK_CODES[tool]),
      )
      .row();
  }

  // Always. Without it the only way out of a submenu is /menu, which a user who
  // arrived here by tapping has no reason to know exists.
  keyboard.text(faTools.buttonBack, encodeCallback(CallbackNamespace.ToolMenu, MenuAction.Root));

  return keyboard;
}
