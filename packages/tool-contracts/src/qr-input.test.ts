import { describe, expect, it } from 'vitest';
import { QR_CONTENT_KIND_VALUES, qrContentSchema } from './qr-input.js';

function parse(value: unknown) {
  return qrContentSchema.safeParse(value);
}

describe('qrContentSchema', () => {
  it('accepts every kind the generator can render', () => {
    // If a kind parses here but the engine cannot build a payload for it, the
    // job reaches the worker and dies there instead of at the boundary.
    const samples: readonly unknown[] = [
      { kind: 'text', text: 'سلام' },
      { kind: 'url', url: 'example.com' },
      { kind: 'wifi', ssid: 'Home', password: 'x', security: 'WPA' },
      { kind: 'phone', phone: '+989123456789' },
      { kind: 'email', email: 'a@b.test' },
      { kind: 'geo', latitude: 35.6892, longitude: 51.389 },
      { kind: 'vcard', name: 'Ali', phone: '+1' },
    ];

    expect(samples).toHaveLength(QR_CONTENT_KIND_VALUES.length);
    for (const sample of samples) {
      expect(parse(sample).success, JSON.stringify(sample)).toBe(true);
    }
  });

  it('refuses coordinates off the globe at the BOUNDARY, not in the worker', () => {
    // The engine checks this too, but by then the job has been persisted,
    // queued and dequeued. A latitude of 91 is not a transient condition, so
    // it should never have been accepted in the first place.
    expect(parse({ kind: 'geo', latitude: 91, longitude: 0 }).success).toBe(false);
    expect(parse({ kind: 'geo', latitude: 0, longitude: 181 }).success).toBe(false);
    expect(parse({ kind: 'geo', latitude: -90, longitude: 180 }).success).toBe(true);
  });

  it('rejects a non-finite coordinate rather than serialising it as null', () => {
    // `JSON.stringify(NaN)` is `null`, so a NaN that slipped through here would
    // reach Redis as a null and fail the worker's re-parse with a message about
    // a missing field instead of a bad one.
    expect(parse({ kind: 'geo', latitude: Number.NaN, longitude: 0 }).success).toBe(false);
    expect(parse({ kind: 'geo', latitude: Number.POSITIVE_INFINITY, longitude: 0 }).success).toBe(
      false,
    );
  });

  it('refuses a Wi-Fi entry with a blank SSID', () => {
    // A whitespace-only SSID passes `min(1)` but names no network; the engine
    // throws on it, which would be an INTERNAL_ERROR for what is user input.
    expect(parse({ kind: 'wifi', ssid: '   ', security: 'WPA' }).success).toBe(false);
  });

  it('allows an open network to carry no password at all', () => {
    expect(parse({ kind: 'wifi', ssid: 'Free', security: 'nopass' }).success).toBe(true);
  });

  it('refuses a security mode the payload builder cannot express', () => {
    expect(parse({ kind: 'wifi', ssid: 'Home', security: 'WPA3' }).success).toBe(false);
  });

  it('caps every free-text field, so nothing absurd is parked in Redis', () => {
    // The byte-accurate ceiling is the engine's — it depends on the error
    // correction level and the character set. This is only here to stop a
    // megabyte of text occupying a queue for the minutes it takes to fail.
    expect(parse({ kind: 'text', text: 'x'.repeat(100_000) }).success).toBe(false);
    expect(parse({ kind: 'url', url: `https://a.test/${'x'.repeat(100_000)}` }).success).toBe(
      false,
    );
  });

  it('refuses an empty value for every kind that needs one', () => {
    const empties: readonly unknown[] = [
      { kind: 'text', text: '' },
      { kind: 'url', url: '' },
      { kind: 'phone', phone: '' },
      { kind: 'email', email: '' },
      { kind: 'vcard', name: '', phone: '+1' },
      { kind: 'vcard', name: 'Ali', phone: '' },
    ];
    for (const sample of empties) {
      expect(parse(sample).success, JSON.stringify(sample)).toBe(false);
    }
  });

  it('rejects an unknown kind instead of guessing', () => {
    expect(parse({ kind: 'bitcoin', address: 'x' }).success).toBe(false);
    expect(parse({ text: 'no kind at all' }).success).toBe(false);
  });
});
