import { describe, expect, it } from 'vitest';
import { ToolErrorCode, isToolError } from '../errors/tool-error.js';
import {
  assertPayloadFits,
  buildQrPayload,
  escapeWifiValue,
  normalizePhone,
  normalizeUrl,
} from './qr-payload.js';

function codeOf(error: unknown): string | undefined {
  return isToolError(error) ? error.code : undefined;
}

describe('escapeWifiValue', () => {
  it('escapes every separator the scheme uses', () => {
    // A password containing one of these terminates the field early, and the
    // code either fails to connect or joins with a truncated password.
    expect(escapeWifiValue('a;b')).toBe('a\\;b');
    expect(escapeWifiValue('a,b')).toBe('a\\,b');
    expect(escapeWifiValue('a:b')).toBe('a\\:b');
    expect(escapeWifiValue('a"b')).toBe('a\\"b');
  });

  it('escapes the backslash FIRST, so earlier passes are not double-escaped', () => {
    // Ordering bug: escaping separators before the escape character would
    // double the backslashes introduced by those passes.
    expect(escapeWifiValue('a\\b')).toBe('a\\\\b');
    expect(escapeWifiValue('a\\;b')).toBe('a\\\\\\;b');
  });

  it('leaves an ordinary password untouched', () => {
    expect(escapeWifiValue('correct horse battery')).toBe('correct horse battery');
  });
});

describe('normalizeUrl', () => {
  it('adds https to a bare host', () => {
    // Without a scheme most readers treat it as text, so the user gets a code
    // that displays a string instead of opening a page.
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com');
  });

  it('leaves an existing scheme alone', () => {
    for (const url of ['http://a.test', 'https://a.test', 'ftp://a.test', 'mailto:a@b.test']) {
      expect(normalizeUrl(url), url).toBe(url);
    }
  });

  it('defaults to https, not http', () => {
    expect(normalizeUrl('bank.example')).toMatch(/^https:/);
  });
});

describe('normalizePhone', () => {
  it('keeps a leading plus and drops presentation characters', () => {
    expect(normalizePhone('+98 (912) 345-6789')).toBe('+989123456789');
    expect(normalizePhone('021 1234 5678')).toBe('02112345678');
  });
});

describe('buildQrPayload', () => {
  it('passes text through unchanged, including Persian', () => {
    expect(buildQrPayload({ kind: 'text', text: 'سلام دنیا' })).toBe('سلام دنیا');
  });

  it('builds a Wi-Fi payload with escaped values', () => {
    const payload = buildQrPayload({
      kind: 'wifi',
      ssid: 'Café;Guest',
      password: 'p:a;s,s',
      security: 'WPA',
    });

    expect(payload.startsWith('WIFI:')).toBe(true);
    expect(payload).toContain('S:Café\\;Guest');
    expect(payload).toContain('P:p\\:a\\;s\\,s');
    expect(payload.endsWith(';;')).toBe(true);
  });

  it('omits the password field entirely for an open network', () => {
    // An empty `P:` makes some Android builds prompt for a key that does not
    // exist.
    const payload = buildQrPayload({ kind: 'wifi', ssid: 'Free', security: 'nopass' });
    expect(payload).not.toContain('P:');
    expect(payload).toContain('T:nopass');
  });

  it('marks a hidden network', () => {
    const payload = buildQrPayload({
      kind: 'wifi',
      ssid: 'Hidden',
      password: 'x',
      security: 'WPA',
      hidden: true,
    });
    expect(payload).toContain('H:true');
  });

  it('refuses a Wi-Fi payload with no SSID', () => {
    expect(() => buildQrPayload({ kind: 'wifi', ssid: '  ', security: 'WPA' })).toThrow();
  });

  it('builds tel, mailto and geo schemes', () => {
    expect(buildQrPayload({ kind: 'phone', phone: '+98 912 345 6789' })).toBe('tel:+989123456789');
    expect(buildQrPayload({ kind: 'email', email: ' a@b.test ' })).toBe('mailto:a@b.test');
    expect(buildQrPayload({ kind: 'geo', latitude: 35.6892, longitude: 51.389 })).toBe(
      'geo:35.6892,51.389',
    );
  });

  it('refuses coordinates outside the globe', () => {
    for (const coords of [
      { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 },
      { latitude: Number.NaN, longitude: 0 },
    ]) {
      expect(() => buildQrPayload({ kind: 'geo', ...coords }), JSON.stringify(coords)).toThrow();
    }
  });

  it('builds a vCard with CRLF line endings', () => {
    // The grammar requires CRLF, and several iOS versions silently refuse a
    // card that uses bare newlines.
    const payload = buildQrPayload({ kind: 'vcard', name: 'Ali', phone: '+9891234' });
    expect(payload).toContain('\r\n');
    expect(payload).not.toMatch(/[^\r]\n/);
    expect(payload.startsWith('BEGIN:VCARD')).toBe(true);
    expect(payload.endsWith('END:VCARD')).toBe(true);
  });

  it('escapes a vCard name so a stray newline cannot end the property', () => {
    const payload = buildQrPayload({
      kind: 'vcard',
      name: 'Ali\nEND:VCARD\nX',
      phone: '+1',
    });
    // The injected terminator must not appear as its own line.
    expect(payload.split('\r\n').filter((l) => l === 'END:VCARD')).toHaveLength(1);
  });

  it('omits an absent vCard email rather than emitting an empty field', () => {
    const payload = buildQrPayload({ kind: 'vcard', name: 'Ali', phone: '+1' });
    expect(payload).not.toContain('EMAIL:');
  });
});

describe('assertPayloadFits', () => {
  it('measures BYTES, not characters', () => {
    // Persian is two to three bytes per character, so a character-based limit
    // would accept a string several times larger than the format allows and
    // fail inside the encoder with a message about version overflow.
    const persian = 'س'.repeat(200);
    expect(persian.length).toBe(200);
    expect(Buffer.byteLength(persian, 'utf8')).toBeGreaterThan(300);

    expect(() => assertPayloadFits(persian, 250)).toThrow();
    expect(() => assertPayloadFits(persian, 500)).not.toThrow();
  });

  it('refuses an empty payload', () => {
    expect(() => assertPayloadFits('', 1_500)).toThrow();
  });

  it('reports the length ceiling with its own code', () => {
    try {
      assertPayloadFits('x'.repeat(100), 10);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect(codeOf(error)).toBe(ToolErrorCode.QrInputTooLong);
    }
  });

  it('never puts the payload in the error, which may be a password', () => {
    try {
      assertPayloadFits('hunter2-secret-wifi-key', 5);
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      const serialized = JSON.stringify(isToolError(error) ? error.context : {});
      expect(serialized).not.toContain('hunter2');
      expect(isToolError(error) && error.message).not.toContain('hunter2');
    }
  });
});
