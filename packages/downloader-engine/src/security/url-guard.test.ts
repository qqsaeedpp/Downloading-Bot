import { describe, expect, it } from 'vitest';
import { EngineError, EngineFailureCode } from '../errors/engine-error.js';
import { createPlatformRegistry } from '../platforms/registry.js';
import { UrlGuard, normalizeUrl } from './url-guard.js';

const guard = new UrlGuard(createPlatformRegistry());

function expectRejected(url: string, code?: EngineFailureCode): EngineError {
  let thrown: unknown;
  try {
    guard.parse(url);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, `expected "${url}" to be rejected`).toBeInstanceOf(EngineError);
  const engineError = thrown as EngineError;
  if (code !== undefined) expect(engineError.code).toBe(code);
  return engineError;
}

describe('UrlGuard — accepted links', () => {
  it.each([
    ['https://www.instagram.com/reel/Cx1y2z3AbCd/', 'instagram'],
    ['https://instagram.com/p/Cx1y2z3AbCd/', 'instagram'],
    ['https://www.tiktok.com/@someone/video/7234567890123456789', 'tiktok'],
    ['https://vm.tiktok.com/ZMabcdefg/', 'tiktok'],
    ['https://www.pinterest.com/pin/1234567890/', 'pinterest'],
    ['https://pin.it/abcdEFG', 'pinterest'],
    ['https://x.com/someone/status/1234567890123456789', 'x'],
    ['https://twitter.com/someone/status/1234567890123456789', 'x'],
    ['https://mobile.twitter.com/someone/status/1234567890123456789', 'x'],
  ])('accepts %s as %s', (url, platform) => {
    expect(guard.parse(url).platform).toBe(platform);
  });

  it('marks a short link so the resolver knows to follow it', () => {
    expect(guard.parse('https://vm.tiktok.com/ZMabcdefg/').isShortLink).toBe(true);
    expect(guard.parse('https://www.tiktok.com/@a/video/7234567890123456789').isShortLink).toBe(
      false,
    );
  });
});

describe('UrlGuard — host confusion', () => {
  it.each([
    'https://instagram.com.evil.test/reel/Cx1y2z3AbCd/',
    'https://evil.test/instagram.com/reel/Cx1y2z3AbCd/',
    'https://notinstagram.com/reel/Cx1y2z3AbCd/',
    'https://pinterest.attacker.test/pin/123/',
    'https://x.com.attacker.test/a/status/1',
  ])('refuses the look-alike host %s', (url) => {
    // An unanchored `includes('instagram.com')` accepts every one of these,
    // which is the single most common way a URL allow-list becomes an SSRF hole.
    expectRejected(url, EngineFailureCode.UnsupportedPlatform);
  });

  it('refuses credentials smuggled in front of the host', () => {
    // Parses with host `evil.test`, not `instagram.com`.
    expectRejected('https://instagram.com@evil.test/reel/abc', EngineFailureCode.InvalidUrl);
  });

  it('treats a trailing dot as the same host rather than a different one', () => {
    expect(guard.parse('https://www.instagram.com./reel/Cx1y2z3AbCd/').platform).toBe('instagram');
  });
});

describe('UrlGuard — SSRF surface', () => {
  it.each([
    'http://127.0.0.1/reel/abc',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/p/abc',
    'http://192.168.1.1/p/abc',
    'http://[::1]/p/abc',
    'http://0.0.0.0/p/abc',
  ])('refuses the bare address %s', (url) => {
    expectRejected(url, EngineFailureCode.InvalidUrl);
  });

  it.each(['http://localhost/p/abc', 'http://foo.localhost/p/abc', 'http://printer.local/p/abc'])(
    'refuses the loopback name %s',
    (url) => {
      expectRejected(url, EngineFailureCode.InvalidUrl);
    },
  );

  it.each([
    'file:///etc/passwd',
    'ftp://instagram.com/p/abc',
    'javascript:alert(1)',
    'data:text/html,x',
  ])('refuses the protocol in %s', (url) => {
    expectRejected(url);
  });

  it('refuses an explicit port on a platform domain', () => {
    expectRejected('https://www.instagram.com:8080/reel/abc', EngineFailureCode.InvalidUrl);
  });

  it('refuses a URL long enough to be doing something other than naming a post', () => {
    expectRejected(
      `https://www.instagram.com/reel/${'a'.repeat(3000)}`,
      EngineFailureCode.InvalidUrl,
    );
  });

  it('refuses input that is not a URL at all', () => {
    expectRejected('', EngineFailureCode.InvalidUrl);
    expectRejected('not a url', EngineFailureCode.InvalidUrl);
  });
});

describe('UrlGuard — supported host, unsupported path', () => {
  it('distinguishes "not a post" from "not our platform"', () => {
    const error = expectRejected(
      'https://www.instagram.com/someprofile/',
      EngineFailureCode.UnsupportedPlatform,
    );
    expect(error.message).toContain('single post');
  });
});

describe('normalizeUrl', () => {
  it('produces the same key for two shares of the same reel', () => {
    const a = guard.parse('https://www.instagram.com/reel/Cx1y2z3AbCd/?igshid=AAA&utm_source=ig');
    const b = guard.parse('https://www.instagram.com/reel/Cx1y2z3AbCd?igshid=BBB');
    // Without this, one reel shared by twenty people is twenty cache misses and
    // twenty downloads.
    expect(a.normalizedUrl).toBe(b.normalizedUrl);
  });

  it('orders remaining query parameters so the key is stable', () => {
    const url = new URL('https://www.instagram.com/p/abc?b=2&a=1');
    expect(normalizeUrl(url, [])).toBe('https://www.instagram.com/p/abc?a=1&b=2');
  });

  it('drops the fragment, forces https and lowercases the host', () => {
    const normalized = normalizeUrl(new URL('http://WWW.Instagram.COM/p/abc#comment-3'), []);
    expect(normalized).toBe('https://www.instagram.com/p/abc');
  });

  it('strips a trailing slash so it does not split the cache', () => {
    expect(normalizeUrl(new URL('https://www.instagram.com/p/abc/'), [])).toBe(
      'https://www.instagram.com/p/abc',
    );
  });
});
