import { ALL_MEDIA_PLATFORMS, DownloadStage, DownloadType } from '@tgtools/shared';
import { describe, expect, it } from 'vitest';
import { DownloadFailureCode } from '../../../domain/errors/download-failure-code.js';
import { PLATFORM_LABELS_FA, fa, supportedPlatformsFa, toPersianDigits } from './fa.js';

describe('the Persian message table', () => {
  it('has a sentence for every failure code', () => {
    // The switch is exhaustive and compiler-checked, so this guards the runtime
    // half: a new code cannot ship without someone deciding what to tell the
    // person waiting for their file.
    for (const code of Object.values(DownloadFailureCode)) {
      const message = fa.failure(code);
      expect(message, code).toBeTruthy();
      expect(message.length, code).toBeGreaterThan(10);
    }
  });

  it('has a label for every stage', () => {
    for (const stage of Object.values(DownloadStage)) {
      expect(fa.stage(stage), stage).toBeTruthy();
    }
  });

  it('never calls a repackaging an optimisation', () => {
    const packaging = fa.stage(DownloadStage.Packaging);
    const normalizing = fa.stage(DownloadStage.Normalizing);

    // A stream copy takes seconds; a re-encode takes minutes. Sharing one
    // wording between them is how a two-second delivery came to look like a
    // stalled one, so the two must stay distinguishable — and the remux must
    // not borrow the word that sets an expectation of a long wait.
    expect(packaging).not.toBe(normalizing);
    expect(packaging).not.toContain('بهینه‌سازی');
    expect(normalizing).toContain('بهینه‌سازی');
  });

  it('has a label for every supported platform', () => {
    // Derived from the vocabulary rather than hard-coded, so adding a platform
    // fails here instead of rendering its raw slug to a Persian-speaking user.
    expect(Object.keys(PLATFORM_LABELS_FA).sort()).toEqual([...ALL_MEDIA_PLATFORMS].sort());
    for (const platform of ALL_MEDIA_PLATFORMS) {
      expect(PLATFORM_LABELS_FA[platform], platform).toBeTruthy();
    }
  });

  it('names every supported platform in the text a user actually reads', () => {
    // The regression: the platform list was written out by hand in three
    // places, so adding YouTube left the "no link found" prompt and the
    // "unsupported link" error both telling users YouTube was not supported —
    // on the very screen they reached by pasting a YouTube link.
    const list = supportedPlatformsFa();
    for (const platform of ALL_MEDIA_PLATFORMS) {
      expect(list, platform).toContain(PLATFORM_LABELS_FA[platform]);
    }
    expect(fa.noUrlFound).toContain(list);
    expect(fa.failure(DownloadFailureCode.UnsupportedPlatform)).toContain(list);
  });

  it('joins the platform list the way Persian does', () => {
    const list = supportedPlatformsFa();
    expect(list).toContain('، ');
    expect(list).toContain(' و ');
    expect(list.endsWith('،')).toBe(false);
  });

  it('never leaks a technical term to the user', () => {
    const forbidden = ['yt-dlp', 'ffmpeg', 'ffprobe', 'undefined', 'NaN', 'Error:', 'stderr'];
    for (const code of Object.values(DownloadFailureCode)) {
      const message = fa.failure(code);
      for (const term of forbidden) {
        expect(message.toLowerCase(), `${code} leaked "${term}"`).not.toContain(term.toLowerCase());
      }
    }
  });
});

describe('the media card', () => {
  it('omits the fields the platform did not supply', () => {
    // Pinterest has no duration and X has no view count; a card that assumes
    // otherwise renders "undefined" to a real person.
    const card = fa.mediaCard({
      title: 'A pin',
      platformLabel: PLATFORM_LABELS_FA.pinterest,
      uploader: undefined,
      durationSeconds: undefined,
      viewCount: undefined,
      likeCount: undefined,
    });
    expect(card).not.toContain('undefined');
    expect(card).not.toContain('NaN');
    expect(card).toContain('A pin');
  });

  it('escapes HTML in a title, because the title is remote input', () => {
    const card = fa.mediaCard({
      title: '<script>alert(1)</script>',
      platformLabel: 'x',
      uploader: undefined,
      durationSeconds: undefined,
      viewCount: undefined,
      likeCount: undefined,
    });
    expect(card).not.toContain('<script>');
    expect(card).toContain('&lt;script&gt;');
  });
});

describe('the progress message', () => {
  it('draws a bar when the total is known', () => {
    const text = fa.downloadProgress({
      percent: 80,
      downloadedBytes: 42 * 1024 * 1024,
      totalBytes: 53 * 1024 * 1024,
      speedBytesPerSecond: 4.8 * 1024 * 1024,
      etaSeconds: 3,
    });
    expect(text).toContain('█');
    expect(text).toContain('۸۰');
  });

  it('reports only what is certain when the total is unknown', () => {
    // Inventing a bar that sits at zero for the whole download would be worse
    // than not drawing one.
    const text = fa.downloadProgress({
      percent: undefined,
      downloadedBytes: 5 * 1024 * 1024,
      totalBytes: undefined,
      speedBytesPerSecond: undefined,
      etaSeconds: undefined,
    });
    expect(text).not.toContain('█');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
  });
});

describe('toPersianDigits', () => {
  it('converts Latin digits and leaves everything else alone', () => {
    expect(toPersianDigits('1080p')).toBe('۱۰۸۰p');
    expect(toPersianDigits('42.3 MB')).toBe('۴۲.۳ MB');
  });
});

describe('option labels', () => {
  it('shows an estimated size when one is known and omits it otherwise', () => {
    expect(fa.optionLabel(DownloadType.Video, '1080p', 45 * 1024 * 1024)).toContain('MB');
    expect(fa.optionLabel(DownloadType.Video, '1080p', undefined)).not.toContain('MB');
  });
});
