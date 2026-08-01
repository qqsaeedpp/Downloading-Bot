import { describe, expect, it } from 'vitest';
import { inspectIpAddress, isPublicIpAddress } from './ip-rules.js';

describe('inspectIpAddress', () => {
  it.each([
    ['169.254.169.254', 'the cloud metadata endpoint that hands out instance credentials'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'the far end of the loopback block'],
    ['10.1.2.3', 'RFC 1918'],
    ['172.16.0.1', 'the start of the 172.16/12 block'],
    ['172.31.255.255', 'the end of the 172.16/12 block'],
    ['192.168.0.1', 'RFC 1918'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', '"this network"'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['198.18.0.1', 'benchmarking'],
  ])('refuses %s (%s)', (address) => {
    expect(inspectIpAddress(address).allowed).toBe(false);
  });

  it('allows a genuinely public address', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('157.240.1.35')).toBe(true);
  });

  it('sees through an IPv4-mapped IPv6 address', () => {
    // `::ffff:127.0.0.1` is an IPv4 destination wearing a costume.
    expect(inspectIpAddress('::ffff:127.0.0.1').allowed).toBe(false);
    expect(inspectIpAddress('::ffff:169.254.169.254').allowed).toBe(false);
    expect(inspectIpAddress('::ffff:8.8.8.8').allowed).toBe(true);
  });

  it.each([
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['64:ff9b::7f00:1', 'NAT64, which translates straight back into IPv4 space'],
    ['2002:7f00:0001::', '6to4, likewise'],
  ])('refuses %s (%s)', (address) => {
    expect(inspectIpAddress(address).allowed).toBe(false);
  });

  it('allows a public IPv6 address', () => {
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('fails closed on anything it cannot parse', () => {
    // A guard that fails open is not a guard.
    expect(inspectIpAddress('not-an-ip').allowed).toBe(false);
    expect(inspectIpAddress('').allowed).toBe(false);
    expect(inspectIpAddress('999.999.999.999').allowed).toBe(false);
  });

  it('explains why an address was refused', () => {
    expect(inspectIpAddress('169.254.169.254').reason).toContain('metadata');
  });
});
