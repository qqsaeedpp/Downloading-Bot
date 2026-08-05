import { describe, expect, it } from 'vitest';
import type { ToolOperation } from './job-payload.js';
import {
  TOOL_JOB_SCHEMA_VERSION,
  expectedInputCount,
  parseToolJobPayload,
  toStorableOperation,
} from './job-payload.js';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: TOOL_JOB_SCHEMA_VERSION,
    jobId: 'job-1',
    shortId: 'abc12345',
    requestId: 'req-1',
    telegram: { userId: 1, chatId: 2, statusMessageId: 3 },
    tool: 'image.compress',
    operation: { tool: 'image.compress', level: 'balanced' },
    inputs: [{ fileId: 'f', fileUniqueId: 'u', receivedAtMs: 1 }],
    ...overrides,
  };
}

describe('parseToolJobPayload', () => {
  it('accepts a well-formed job', () => {
    const result = parseToolJobPayload(payload());
    expect(result.ok).toBe(true);
  });

  it('refuses a payload whose tool and operation disagree', () => {
    // Not merely odd: it would be QUEUED as one kind of work and EXECUTED as
    // another, which is how a QR job ends up on the video queue.
    const result = parseToolJobPayload(
      payload({ tool: 'video.remove_audio', operation: { tool: 'image.compress', level: 'high' } }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('disagree');
  });

  it('returns a reason rather than throwing, so a bad job is not retried', () => {
    // Retrying a payload the schema rejects burns the attempt budget to reach
    // exactly the same answer.
    for (const bad of [undefined, null, {}, 'string', 42, payload({ jobId: '' })]) {
      const result = parseToolJobPayload(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.ok === false && result.reason.length).toBeGreaterThan(0);
    }
  });

  it('rejects a job from a different schema version', () => {
    // A queue outlives a deployment, so this is the normal case during a
    // rolling restart, not an exotic one.
    expect(parseToolJobPayload(payload({ schemaVersion: 2 })).ok).toBe(false);
  });

  it('validates each tool arm against its own options', () => {
    const cases = [
      [{ tool: 'image.resize', width: 1080, height: 1920, fit: 'cover' }, true],
      [{ tool: 'image.resize', width: 0, fit: 'cover' }, false],
      [{ tool: 'image.resize', width: 1080, fit: 'fill' }, false],
      [{ tool: 'video.extract_mp3', quality: '192' }, true],
      [{ tool: 'video.extract_mp3', quality: '64' }, false],
      [{ tool: 'pdf.to_images', format: 'png', dpi: 150 }, true],
      [{ tool: 'pdf.to_images', format: 'png', dpi: 5_000 }, false],
      [
        {
          tool: 'qr.generate',
          content: { kind: 'text', text: 'x' },
          format: 'png',
          size: 512,
          errorCorrection: 'M',
        },
        true,
      ],
      [
        {
          tool: 'qr.generate',
          content: { kind: 'geo', latitude: 91, longitude: 0 },
          format: 'png',
          size: 512,
          errorCorrection: 'M',
        },
        false,
      ],
    ] as const;

    for (const [operation, valid] of cases) {
      const result = parseToolJobPayload(payload({ tool: operation.tool, operation }));
      expect(result.ok, JSON.stringify(operation)).toBe(valid);
    }
  });

  it('refuses a fit mode that would stretch the image', () => {
    // `fill` scales the axes independently. It is excluded from the schema so
    // it cannot arrive at the processor at all.
    expect(
      parseToolJobPayload(
        payload({
          tool: 'image.resize',
          operation: { tool: 'image.resize', width: 100, height: 100, fit: 'fill' },
        }),
      ).ok,
    ).toBe(false);
  });

  it('carries no path, URL or token — only Telegram references', () => {
    // The property that lets a job sit in Redis at all.
    const result = parseToolJobPayload(payload());
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result.ok ? result.payload : {});
    expect(serialized).not.toMatch(/https?:\/\//);
    expect(serialized).not.toMatch(/\/(var|tmp|data)\//);
  });
});

describe('expectedInputCount', () => {
  it('allows several files only for images-to-PDF', () => {
    expect(expectedInputCount('pdf.images_to_pdf').max).toBeGreaterThan(1);
    for (const tool of ['image.compress', 'image.resize', 'video.extract_mp3'] as const) {
      expect(expectedInputCount(tool), tool).toEqual({ min: 1, max: 1 });
    }
  });

  it('expects no file at all for QR', () => {
    // QR is built from text. Accepting a file would be accepting something it
    // has no way to use.
    expect(expectedInputCount('qr.generate')).toEqual({ min: 0, max: 0 });
  });
});

describe('toStorableOperation', () => {
  const wifi = {
    tool: 'qr.generate',
    content: {
      kind: 'wifi',
      ssid: 'Babaee-Home',
      password: 'hunter2-very-secret',
      security: 'WPA',
    },
    format: 'png',
    size: 512,
    errorCorrection: 'M',
  } as const satisfies ToolOperation;

  it('keeps everything the user typed out of the QR row', () => {
    // `tool_jobs` is an audit table with no expiry. A Wi-Fi password written
    // there outlives the job, the chat and very probably the network.
    const serialized = JSON.stringify(toStorableOperation(wifi));

    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Babaee-Home');
  });

  it('stores QR by allow-list, so a new content field cannot leak by default', () => {
    // The bug this prevents is a future one: someone adds `note` to the vCard
    // arm, a deny-list implementation does not know about it, and it starts
    // being persisted with nobody noticing. Naming the safe keys means the
    // failure mode of forgetting is omission, not disclosure.
    expect(Object.keys(toStorableOperation(wifi)).sort()).toEqual([
      'errorCorrection',
      'format',
      'kind',
      'size',
      'tool',
    ]);
  });

  it('records WHICH kind of QR was made, which is not itself a secret', () => {
    // Without it the row cannot answer "what did this job do", and the event
    // trail exists precisely to answer that.
    expect(toStorableOperation(wifi)).toMatchObject({ tool: 'qr.generate', kind: 'wifi' });
  });

  it('leaves every other tool intact, options and all', () => {
    // These carry dimensions and quality settings, not personal data, and a row
    // that has forgotten the DPI cannot explain what it produced.
    const operation = { tool: 'pdf.to_images', format: 'png', dpi: 200 } as const;
    expect(toStorableOperation(operation)).toEqual(operation);
  });

  it('produces something a jsonb column round-trips unchanged', () => {
    const operation = {
      tool: 'image.resize',
      width: 1080,
      height: 1350,
      fit: 'cover',
    } as const satisfies ToolOperation;
    const stored: unknown = JSON.parse(JSON.stringify(toStorableOperation(operation)));
    expect(stored).toEqual(operation);
  });
});
