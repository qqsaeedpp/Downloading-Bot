import { describe, expect, it } from 'vitest';
import {
  ALL_TOOL_FAMILIES,
  ALL_TOOL_KEYS,
  ToolJobStatus,
  ToolKey,
  isTerminalToolJobStatus,
  isToolKey,
  toolFamilyOf,
} from './tool-vocabulary.js';

describe('tool vocabulary', () => {
  it('derives a real family from every key', () => {
    // `toolFamilyOf` casts, and the cast is only sound because every key begins
    // with a family name. Asserting it for ALL keys is what keeps that true
    // when someone adds the ninth tool.
    for (const key of ALL_TOOL_KEYS) {
      expect(ALL_TOOL_FAMILIES, key).toContain(toolFamilyOf(key));
    }
  });

  it('prices images-to-PDF as PDF work, not image work', () => {
    // It CONSUMES images but the time and memory go into building the document,
    // so it belongs on the PDF queue with the PDF concurrency of 1.
    expect(toolFamilyOf(ToolKey.ImagesToPdf)).toBe('pdf');
    expect(toolFamilyOf(ToolKey.ImageCompress)).toBe('image');
  });

  it('recognises exactly its own keys', () => {
    for (const key of ALL_TOOL_KEYS) expect(isToolKey(key)).toBe(true);
    for (const bad of ['image.rotate', 'video', '', 'IMAGE.COMPRESS', 'pdf.']) {
      expect(isToolKey(bad), bad).toBe(false);
    }
  });

  it('treats every ending state as terminal and no working state as terminal', () => {
    for (const status of [
      ToolJobStatus.Completed,
      ToolJobStatus.Failed,
      ToolJobStatus.Cancelled,
      ToolJobStatus.Expired,
    ]) {
      expect(isTerminalToolJobStatus(status), status).toBe(true);
    }
    for (const status of [
      ToolJobStatus.Pending,
      ToolJobStatus.Queued,
      ToolJobStatus.Receiving,
      ToolJobStatus.Processing,
      ToolJobStatus.Uploading,
    ]) {
      expect(isTerminalToolJobStatus(status), status).toBe(false);
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(ALL_TOOL_KEYS).size).toBe(ALL_TOOL_KEYS.length);
  });
});
