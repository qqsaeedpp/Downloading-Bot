import { ToolKey } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import type { ToolSession } from './session.js';
import {
  TOOL_SESSION_SCHEMA_VERSION,
  parseToolSession,
  toolSessionKey,
  toolSessionSchema,
} from './session.js';

function input(overrides: Record<string, unknown> = {}) {
  return {
    fileId: 'AgACAgQAAx0',
    fileUniqueId: 'AQADuq8',
    receivedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

const awaitingInput: ToolSession = {
  schemaVersion: TOOL_SESSION_SCHEMA_VERSION,
  tool: ToolKey.ImageCompress,
  createdAtMs: 1_700_000_000_000,
  state: 'awaiting_input',
};

describe('toolSessionSchema', () => {
  it('accepts every state the flow can be in', () => {
    const states: ToolSession[] = [
      awaitingInput,
      {
        ...awaitingInput,
        state: 'collecting_inputs',
        inputs: [input()],
      },
      {
        ...awaitingInput,
        state: 'awaiting_options',
        inputs: [input()],
        draftOptions: { level: 'balanced' },
        step: 'quality',
      },
      {
        ...awaitingInput,
        state: 'ready_for_confirmation',
        inputs: [input()],
        options: { level: 'balanced' },
      },
      {
        ...awaitingInput,
        state: 'queued',
        jobId: 'job-1',
        shortId: 'abc12345',
      },
    ];

    for (const state of states) {
      expect(toolSessionSchema.safeParse(state).success, state.state).toBe(true);
    }
  });

  it('refuses a state that claims inputs it does not have', () => {
    // The reason this is a discriminated union and not a state string beside a
    // bag of optional fields: a handler for `awaiting_options` must be able to
    // read `inputs` without checking whether they exist.
    expect(
      toolSessionSchema.safeParse({
        ...awaitingInput,
        state: 'collecting_inputs',
        inputs: [],
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown tool key', () => {
    expect(toolSessionSchema.safeParse({ ...awaitingInput, tool: 'image.rotate' }).success).toBe(
      false,
    );
  });
});

describe('parseToolSession', () => {
  it('round-trips a session through JSON', () => {
    const parsed = parseToolSession(JSON.stringify(awaitingInput));
    expect(parsed).toEqual(awaitingInput);
  });

  it('never throws, whatever is in Redis', () => {
    // A session written by an older release, truncated by an eviction, or
    // hand-edited is routine during a rolling deploy. Raising here would fail
    // the user's next message instead of quietly restarting the flow.
    for (const raw of [
      undefined,
      null,
      '',
      'not json',
      '{',
      '[]',
      '{"state":"awaiting_input"}',
      JSON.stringify({ ...awaitingInput, schemaVersion: 99 }),
      JSON.stringify({ ...awaitingInput, state: 'teleporting' }),
    ]) {
      expect(() => parseToolSession(raw)).not.toThrow();
      expect(parseToolSession(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('discards a session from a future schema rather than half-reading it', () => {
    // The whole point of the version field. A shape this build does not
    // understand must be dropped, not coerced into something plausible.
    const future = JSON.stringify({ ...awaitingInput, schemaVersion: 2 });
    expect(parseToolSession(future)).toBeUndefined();
  });

  it('keeps no file path, URL or token — only Telegram references', () => {
    // The security property that lets sessions live in Redis at all.
    const session = {
      ...awaitingInput,
      state: 'collecting_inputs' as const,
      inputs: [input({ originalName: 'holiday.jpg', declaredMimeType: 'image/jpeg' })],
    };

    const parsed = parseToolSession(JSON.stringify(session));
    expect(parsed).toBeDefined();

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/\/(var|tmp|data)\//);
    expect(serialized).not.toMatch(/\d{8,}:[A-Za-z0-9_-]{30,}/);
  });
});

describe('toolSessionKey', () => {
  it('scopes state to one bot as well as one user', () => {
    // Staging and production sharing a Redis is the normal deployment, and two
    // tokens must not share conversation state.
    expect(toolSessionKey('bot-a', 42)).toBe('tool-session:bot-a:42');
    expect(toolSessionKey('bot-a', 42)).not.toBe(toolSessionKey('bot-b', 42));
    expect(toolSessionKey('bot-a', 42)).not.toBe(toolSessionKey('bot-a', 43));
  });
});
