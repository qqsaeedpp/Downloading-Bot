import { describe, expect, it } from 'vitest';
import {
  CALLBACK_MAX_BYTES,
  CallbackAction,
  DOWNLOAD_CALLBACK_PATTERN,
  decodeCallback,
  encodeCallback,
} from './callback-data.js';

const SHORT_ID = 'A1B2C3D4E5';

describe('callback data', () => {
  it('round-trips a quality selection', () => {
    const encoded = encodeCallback({
      shortId: SHORT_ID,
      action: CallbackAction.SelectQuality,
      optionId: 'v1080',
    });
    expect(decodeCallback(encoded)).toEqual({
      shortId: SHORT_ID,
      action: CallbackAction.SelectQuality,
      optionId: 'v1080',
    });
  });

  it('round-trips a cancellation', () => {
    const encoded = encodeCallback({
      shortId: SHORT_ID,
      action: CallbackAction.Cancel,
      optionId: undefined,
    });
    expect(decodeCallback(encoded)).toEqual({
      shortId: SHORT_ID,
      action: CallbackAction.Cancel,
      optionId: undefined,
    });
  });

  it('stays inside Telegram s 64-byte budget', () => {
    const encoded = encodeCallback({
      shortId: SHORT_ID,
      action: CallbackAction.SelectQuality,
      optionId: 'a320',
    });
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(CALLBACK_MAX_BYTES);
  });

  it('fails loudly rather than producing a button that silently does nothing', () => {
    expect(() =>
      encodeCallback({
        shortId: 'A'.repeat(60),
        action: CallbackAction.SelectQuality,
        optionId: 'v1080',
      }),
    ).toThrow(/exceeds/);
  });

  it('matches its own pattern, so the grammY filter and the decoder agree', () => {
    const encoded = encodeCallback({
      shortId: SHORT_ID,
      action: CallbackAction.SelectQuality,
      optionId: 'v720',
    });
    expect(DOWNLOAD_CALLBACK_PATTERN.test(encoded)).toBe(true);
  });
});

describe('decodeCallback — hostile and stale input', () => {
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['another feature s callback', 'other:A1B2C3D4E5:q:v1080'],
    ['a missing action', 'dl:A1B2C3D4E5'],
    ['an unknown action', 'dl:A1B2C3D4E5:z:v1080'],
    ['too many segments', 'dl:A1B2C3D4E5:q:v1080:extra'],
    ['a short id with illegal characters', 'dl:../../etc:q:v1080'],
    ['a short id that is too short', 'dl:AB:q:v1080'],
    ['an option id with a separator in it', 'dl:A1B2C3D4E5:q:v:1080'],
    ['an option id with punctuation', 'dl:A1B2C3D4E5:q:v-1080'],
    ['a quality action with no option', 'dl:A1B2C3D4E5:q'],
  ])('returns undefined for %s', (_label, input) => {
    // Callback data is user-controllable. An unrecognised value is an ordinary
    // event — an old keyboard, another feature's button — not an exception.
    expect(decodeCallback(input)).toBeUndefined();
  });

  it('rejects anything over the byte budget without parsing it', () => {
    expect(decodeCallback(`dl:${'A'.repeat(200)}:q:v1080`)).toBeUndefined();
  });

  it('rejects the ambiguous characters the short-id alphabet excludes', () => {
    // I, L, O and U are absent so a token can never be misread or read as a word.
    expect(decodeCallback('dl:AIBOCLDUE5:q:v1080')).toBeUndefined();
  });
});
