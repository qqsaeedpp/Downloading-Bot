import { ALL_TOOL_KEYS, ToolKey } from '@tgtools/shared';
import { toStorableOperation } from '@tgtools/tool-contracts';
import { describe, expect, it } from 'vitest';
import { buildToolOperation } from './build-operation.js';
import {
  isOfferedChoice,
  isOptionDraftComplete,
  nextOptionStep,
  optionStepsFor,
} from './option-steps.js';

/** Answer every question with its first offered choice; type `body` for text steps. */
function answerEverything(tool: ToolKey, textAnswer = 'hello'): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const step of optionStepsFor(tool)) {
    draft[step.id] = step.kind === 'text' ? textAnswer : step.choices[0]?.value;
  }
  return draft;
}

describe('the option steps', () => {
  it('asks the first UNANSWERED question, not the next in sequence', () => {
    // So a user who goes back and changes one answer resumes where they left
    // off instead of being asked everything again.
    const steps = optionStepsFor(ToolKey.PdfToImages);
    const first = steps[0];
    const second = steps[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    expect(nextOptionStep(ToolKey.PdfToImages, {})?.id).toBe(first?.id);
    expect(nextOptionStep(ToolKey.PdfToImages, { [first?.id ?? '']: 'png' })?.id).toBe(second?.id);
  });

  it('reports a tool with no questions as immediately complete', () => {
    // `video.remove_audio` does exactly one thing. A flow that asked anyway
    // would be a question with one answer.
    expect(optionStepsFor(ToolKey.VideoRemoveAudio)).toHaveLength(0);
    expect(isOptionDraftComplete(ToolKey.VideoRemoveAudio, {})).toBe(true);
  });

  it('refuses a value the step never offered', () => {
    // Callback data is attacker-controlled — anyone can send a `callback_query`
    // — and every button ever sent stays clickable forever. Without this check
    // a hand-made payload puts an arbitrary string straight into the draft.
    const step = optionStepsFor(ToolKey.ImageConvert)[0];
    expect(step).toBeDefined();
    if (step === undefined) return;

    expect(isOfferedChoice(step, 'webp')).toBe(true);
    expect(isOfferedChoice(step, 'bmp')).toBe(false);
    expect(isOfferedChoice(step, '')).toBe(false);
  });

  it('uses only callback-safe ids and values', () => {
    // They travel on buttons, and the codec refuses anything outside
    // [A-Za-z0-9_-] because a smuggled separator shifts every following field.
    for (const tool of ALL_TOOL_KEYS) {
      for (const step of optionStepsFor(tool)) {
        expect(step.id, `${tool}/${step.id}`).toMatch(/^[A-Za-z0-9_-]+$/);
        if (step.kind !== 'choice') continue;
        for (const choice of step.choices) {
          expect(choice.value, `${tool}/${step.id}/${choice.value}`).toMatch(/^[A-Za-z0-9_-]+$/);
          expect(choice.label, choice.value).toBeTruthy();
        }
      }
    }
  });

  it('never gives one step two choices with the same value', () => {
    for (const tool of ALL_TOOL_KEYS) {
      for (const step of optionStepsFor(tool)) {
        if (step.kind !== 'choice') continue;
        const values = step.choices.map((choice) => choice.value);
        expect(new Set(values).size, `${tool}/${step.id}`).toBe(values.length);
      }
    }
  });

  it('asks for QR content by TYPING, never by tapping', () => {
    // It can be a Wi-Fi password. A button would put it in callback data, which
    // is logged by every proxy between here and Telegram.
    const body = optionStepsFor(ToolKey.QrGenerate).find((step) => step.id === 'body');
    expect(body?.kind).toBe('text');
  });
});

describe('buildToolOperation', () => {
  it('builds a valid operation for every tool in the vocabulary', () => {
    // A tool whose flow cannot produce a valid operation is one the user can
    // reach and never complete.
    for (const tool of ALL_TOOL_KEYS) {
      const result = buildToolOperation(tool, answerEverything(tool));
      expect(result.ok, `${tool}: ${result.ok ? '' : result.reason}`).toBe(true);
      expect(result.ok && result.operation.tool).toBe(tool);
    }
  });

  it('refuses an incomplete draft rather than inventing defaults', () => {
    // A half-answered flow that silently picked values would hand the user a
    // file built to settings they never chose.
    for (const tool of ALL_TOOL_KEYS) {
      if (optionStepsFor(tool).length === 0) continue;
      expect(buildToolOperation(tool, {}).ok, tool).toBe(false);
    }
  });

  it('validates against the wire schema, not just its own assembly', () => {
    // The draft is built from callback data. A value that slipped past the
    // choice check must still be refused here.
    expect(buildToolOperation(ToolKey.ImageConvert, { fmt: 'bmp' }).ok).toBe(false);
    expect(buildToolOperation(ToolKey.VideoExtractMp3, { q: '64' }).ok).toBe(false);
    expect(buildToolOperation(ToolKey.PdfToImages, { fmt: 'png', dpi: '9999' }).ok).toBe(false);
  });

  it('turns a compression target of "no limit" into an absent field', () => {
    // Not a zero. `targetBytes: 0` fails the schema's `.positive()`, and a
    // target of zero would mean "shrink to nothing" if it did not.
    const result = buildToolOperation(ToolKey.ImageCompress, { lvl: 'balanced', tgt: 'no' });
    expect(result.ok).toBe(true);
    expect(result.ok && 'targetBytes' in result.operation).toBe(false);
  });

  it('expands a resize preset into real dimensions', () => {
    const result = buildToolOperation(ToolKey.ImageResize, { sz: 'sq' });
    expect(result.ok && result.operation).toMatchObject({
      width: 1080,
      height: 1080,
      fit: 'cover',
    });
  });

  it('refuses a resize preset that is not in the table', () => {
    expect(buildToolOperation(ToolKey.ImageResize, { sz: 'enormous' }).ok).toBe(false);
  });

  it('reads a Wi-Fi line into SSID, password and security', () => {
    const result = buildToolOperation(ToolKey.QrGenerate, {
      kind: 'wifi',
      body: 'HomeNet | s3cret',
      fmt: 'png',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.operation).toMatchObject({
      content: { kind: 'wifi', ssid: 'HomeNet', password: 's3cret', security: 'WPA' },
    });
  });

  it('treats a Wi-Fi line with no password as an OPEN network', () => {
    // An empty `P:` field makes some Android builds prompt for a key that does
    // not exist, so the contract refuses an empty password outright.
    const result = buildToolOperation(ToolKey.QrGenerate, {
      kind: 'wifi',
      body: 'FreeCafe',
      fmt: 'png',
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.operation).toMatchObject({
      content: { kind: 'wifi', security: 'nopass' },
    });
    expect(result.ok && JSON.stringify(result.operation)).not.toContain('password');
  });

  it('refuses coordinates the user did not actually type', () => {
    // `Number('')` is 0, which would silently place them in the Gulf of Guinea.
    for (const body of ['', '35.6892', '35.6892|', '|51.389', 'north|east']) {
      const result = buildToolOperation(ToolKey.QrGenerate, { kind: 'geo', body, fmt: 'png' });
      expect(result.ok, body).toBe(false);
    }
  });

  it('accepts real coordinates', () => {
    const result = buildToolOperation(ToolKey.QrGenerate, {
      kind: 'geo',
      body: '35.6892 | 51.389',
      fmt: 'png',
    });
    expect(result.ok && result.operation).toMatchObject({
      content: { kind: 'geo', latitude: 35.6892, longitude: 51.389 },
    });
  });

  it('refuses a vCard with no name or no phone', () => {
    for (const body of ['', 'Ali', '|+98912']) {
      expect(
        buildToolOperation(ToolKey.QrGenerate, { kind: 'vcard', body, fmt: 'png' }).ok,
        body,
      ).toBe(false);
    }
  });

  it('keeps the QR content out of anything that gets persisted', () => {
    // The end-to-end check on the privacy rule: what this builds is what the
    // bot then stores, and `toStorableOperation` is what stands between a
    // Wi-Fi key and a row with no expiry.
    const result = buildToolOperation(ToolKey.QrGenerate, {
      kind: 'wifi',
      body: 'Babaee-Home | hunter2-very-secret',
      fmt: 'png',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = JSON.stringify(toStorableOperation(result.operation));

    expect(stored).not.toContain('hunter2');
    expect(stored).not.toContain('Babaee-Home');
  });

  it('refuses a QR kind that is not one the generator can render', () => {
    expect(
      buildToolOperation(ToolKey.QrGenerate, { kind: 'bitcoin', body: 'x', fmt: 'png' }).ok,
    ).toBe(false);
  });
});
