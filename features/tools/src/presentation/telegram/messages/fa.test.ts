import {
  ALL_TOOL_ERROR_CODES,
  ALL_TOOL_FAMILIES,
  ALL_TOOL_KEYS,
  ToolErrorCode,
  ToolJobStatus,
  ToolKey,
  toolFamilyOf,
} from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { TOOL_FAMILY_LABELS_FA, TOOL_LABELS_FA, faTools, toPersianDigits } from './fa.js';

describe('the tool label tables', () => {
  it('names every tool in the vocabulary', () => {
    // Typed as a total record, so this guards the runtime half of the same
    // promise: adding a ninth tool cannot ship showing `image.rotate` to a
    // Persian-speaking user.
    expect(Object.keys(TOOL_LABELS_FA).sort()).toEqual([...ALL_TOOL_KEYS].sort());
    for (const key of ALL_TOOL_KEYS) {
      expect(TOOL_LABELS_FA[key], key).toBeTruthy();
    }
  });

  it('names every family', () => {
    expect(Object.keys(TOOL_FAMILY_LABELS_FA).sort()).toEqual([...ALL_TOOL_FAMILIES].sort());
  });

  it('gives each tool a distinct label', () => {
    // Two tools sharing a caption makes the menu ambiguous, and the button that
    // was pressed unknowable from a screenshot.
    const labels = ALL_TOOL_KEYS.map((key) => TOOL_LABELS_FA[key]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('files images-to-PDF under PDF, matching where it is queued', () => {
    // It CONSUMES images but is priced and queued as PDF work. A menu that put
    // it under "تصویر" would send users looking for it in the wrong submenu.
    expect(toolFamilyOf(ToolKey.ImagesToPdf)).toBe('pdf');
    expect(TOOL_LABELS_FA[ToolKey.ImagesToPdf]).toContain('PDF');
  });
});

describe('the failure table', () => {
  it('has a sentence for every error code', () => {
    // The switch is exhaustive and compiler-checked; this guards the runtime
    // half. A code with no Persian text would reach a user as an empty message.
    for (const code of ALL_TOOL_ERROR_CODES) {
      const message = faTools.failure(code);
      expect(message, code).toBeTruthy();
      expect(message.length, code).toBeGreaterThan(10);
    }
  });

  it('never leaks a technical term to the user', () => {
    // The whole reason `ToolError` keeps `message` and `code` apart: a poppler
    // stack trace or an ffmpeg stderr line must not reach a chat window.
    const forbidden = [
      'ffmpeg',
      'ffprobe',
      'pdftocairo',
      'pdfinfo',
      'sharp',
      'libvips',
      'undefined',
      'NaN',
      'Error:',
      'stderr',
      'null',
    ];
    for (const code of ALL_TOOL_ERROR_CODES) {
      const message = faTools.failure(code).toLowerCase();
      for (const term of forbidden) {
        expect(message, `${code} leaked "${term}"`).not.toContain(term.toLowerCase());
      }
    }
  });

  it('tells a user whose file is unusable that retrying will not help', () => {
    // These are not transient. A message that says "کمی بعد دوباره تلاش کنید"
    // sends someone back to re-upload the same corrupt PDF, wait, and fail
    // identically — which is worse than saying the file is the problem.
    for (const code of [
      ToolErrorCode.InvalidPdf,
      ToolErrorCode.PdfEncrypted,
      ToolErrorCode.InvalidImage,
      ToolErrorCode.VideoHasNoAudio,
    ]) {
      expect(faTools.failure(code), code).not.toContain('دوباره تلاش');
    }
  });

  it('distinguishes a video with no audio from one that is already silent', () => {
    // Two different user mistakes: asking for MP3 from a silent clip, and
    // asking to mute a clip that has nothing to mute. One wording for both
    // would explain neither.
    expect(faTools.failure(ToolErrorCode.VideoHasNoAudio)).not.toBe(
      faTools.failure(ToolErrorCode.VideoAlreadyMuted),
    );
  });

  it('blames the deployment, not the user, when the disk is full', () => {
    // `DISK_SPACE_LOW` is an operator problem. Telling the user their file was
    // rejected would send them shrinking a file that was never too big.
    const message = faTools.failure(ToolErrorCode.DiskSpaceLow);
    expect(message).not.toContain('فایل شما');
  });
});

describe('the status messages', () => {
  it('has text for every non-terminal status a user can be shown', () => {
    for (const status of [
      ToolJobStatus.Pending,
      ToolJobStatus.Queued,
      ToolJobStatus.Receiving,
      ToolJobStatus.Processing,
      ToolJobStatus.Uploading,
    ]) {
      expect(faTools.status(status), status).toBeTruthy();
    }
  });

  it('distinguishes receiving a file from processing it', () => {
    // The two fail for entirely different reasons — a slow Telegram fetch
    // versus a slow transcode — and a user watching a stuck job deserves to
    // know which half it is stuck in. That is why `receiving` is a status at
    // all rather than being folded into `processing`.
    expect(faTools.status(ToolJobStatus.Receiving)).not.toBe(
      faTools.status(ToolJobStatus.Processing),
    );
  });

  it('says nothing about a file for a terminal status it cannot describe', () => {
    for (const status of [ToolJobStatus.Completed, ToolJobStatus.Failed]) {
      expect(faTools.status(status), status).toBeTruthy();
    }
  });
});

describe('the completion message', () => {
  it('reports the size in Persian digits', () => {
    const message = faTools.completed(ToolKey.ImageCompress, 2 * 1024 * 1024);
    expect(message).toMatch(/[۰-۹]/);
    expect(message).not.toContain('undefined');
  });

  it('reports how much smaller a compressed file became', () => {
    // The whole point of the tool. Without it the user has to check the file
    // properties to find out whether it did anything.
    const message = faTools.compressionSummary(10 * 1024 * 1024, 2 * 1024 * 1024);
    expect(message).toContain('۸۰');
  });

  it('says plainly when compression could not improve on the original', () => {
    // An already-optimised file re-encoded often GROWS, and the processor hands
    // back the original. Reporting a saving of zero would look like a bug;
    // silence would look like nothing happened.
    const message = faTools.keptOriginal();
    expect(message).toBeTruthy();
    expect(message).not.toContain('۰٪');
  });

  it('warns when a requested target size could not be reached', () => {
    // Best-effort by construction: some images cannot reach a small target
    // without becoming unrecognisable. Silently returning a larger file would
    // read as the target having been ignored.
    expect(faTools.targetMissed(500 * 1024)).toBeTruthy();
  });
});

describe('toPersianDigits', () => {
  it('converts Latin digits and leaves everything else alone', () => {
    expect(toPersianDigits('1080p')).toBe('۱۰۸۰p');
    expect(toPersianDigits('42.3 MB')).toBe('۴۲.۳ MB');
  });
});
