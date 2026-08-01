import { isIP } from 'node:net';

/**
 * Address ranges that must never be reachable from a user-supplied URL. The
 * headline risk is the cloud metadata endpoint at 169.254.169.254, which hands
 * out instance credentials to anything that can make an HTTP request from
 * inside the VM — but every range here is either unroutable, internal, or
 * capable of being pointed somewhere internal.
 */
interface Ipv4Range {
  readonly cidr: string;
  readonly why: string;
}

const IPV4_BLOCKED: readonly Ipv4Range[] = [
  { cidr: '0.0.0.0/8', why: '"this network" — often an alias for localhost' },
  { cidr: '10.0.0.0/8', why: 'RFC 1918 private' },
  { cidr: '100.64.0.0/10', why: 'carrier-grade NAT' },
  { cidr: '127.0.0.0/8', why: 'loopback' },
  { cidr: '169.254.0.0/16', why: 'link-local, includes the cloud metadata service' },
  { cidr: '172.16.0.0/12', why: 'RFC 1918 private' },
  { cidr: '192.0.0.0/24', why: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', why: 'documentation' },
  { cidr: '192.88.99.0/24', why: '6to4 relay anycast' },
  { cidr: '192.168.0.0/16', why: 'RFC 1918 private' },
  { cidr: '198.18.0.0/15', why: 'benchmarking' },
  { cidr: '198.51.100.0/24', why: 'documentation' },
  { cidr: '203.0.113.0/24', why: 'documentation' },
  { cidr: '224.0.0.0/4', why: 'multicast' },
  { cidr: '240.0.0.0/4', why: 'reserved, includes the broadcast address' },
];

interface ParsedCidr {
  readonly base: number;
  readonly mask: number;
  readonly why: string;
}

const IPV4_PARSED: readonly ParsedCidr[] = IPV4_BLOCKED.map(({ cidr, why }) => {
  const [address = '', prefixText = '0'] = cidr.split('/');
  const prefix = Number(prefixText);
  // `>>> 0` on both the mask and the base is load-bearing, not cosmetic.
  // JavaScript's bitwise operators work on SIGNED 32-bit integers, so
  // `0xac100000 & 0xfff00000` (172.16/12) evaluates to a negative number while
  // the runtime comparison below produces an unsigned one — and the two never
  // match. Left unnormalised, every range whose first octet has the high bit
  // set (172.16/12, 192.168/16, 169.254/16 — the cloud metadata endpoint —
  // 198.18/15, 224/4 and 240/4) silently passes the guard.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ipv4ToInt(address) & mask) >>> 0, mask, why };
});

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map(Number);
  return (
    (((parts[0] ?? 0) << 24) |
      ((parts[1] ?? 0) << 16) |
      ((parts[2] ?? 0) << 8) |
      (parts[3] ?? 0)) >>>
    0
  );
}

export interface AddressVerdict {
  readonly allowed: boolean;
  readonly reason: string | undefined;
}

const ALLOWED: AddressVerdict = { allowed: true, reason: undefined };

/**
 * Decide whether an IP literal may be contacted. Unknown formats are refused
 * rather than allowed: a guard that fails open is not a guard.
 */
export function inspectIpAddress(address: string): AddressVerdict {
  // `new URL('http://[::1]/').hostname` keeps the brackets, so a caller passing
  // a hostname straight through would otherwise fail the `isIP` check and fall
  // out of the IP path entirely.
  const bare = address.replace(/^\[|\]$/g, '');
  const version = isIP(bare);
  if (version === 4) return inspectIpv4(bare);
  if (version === 6) return inspectIpv6(bare);
  return { allowed: false, reason: 'not a recognisable IP address' };
}

function inspectIpv4(address: string): AddressVerdict {
  const value = ipv4ToInt(address);
  for (const { base, mask, why } of IPV4_PARSED) {
    if ((value & mask) >>> 0 === base) return { allowed: false, reason: why };
  }
  return ALLOWED;
}

function inspectIpv6(address: string): AddressVerdict {
  const lowered = address.toLowerCase().replace(/^\[|\]$/g, '');

  // An IPv4-mapped address (::ffff:127.0.0.1) is an IPv4 destination wearing a
  // costume; judge it by the address it actually reaches.
  const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(lowered);
  if (mapped?.[1] !== undefined) return inspectIpv4(mapped[1]);

  if (lowered === '::' || lowered === '::1') {
    return { allowed: false, reason: 'IPv6 unspecified or loopback' };
  }
  // fc00::/7 — unique local.
  if (/^f[cd][0-9a-f]{2}:/.test(lowered)) return { allowed: false, reason: 'IPv6 unique local' };
  // fe80::/10 — link-local.
  if (/^fe[89ab][0-9a-f]:/.test(lowered)) return { allowed: false, reason: 'IPv6 link-local' };
  // ff00::/8 — multicast.
  if (/^ff[0-9a-f]{2}:/.test(lowered)) return { allowed: false, reason: 'IPv6 multicast' };
  // 64:ff9b::/96 — NAT64, which translates straight back into IPv4 space.
  if (lowered.startsWith('64:ff9b:')) return { allowed: false, reason: 'IPv6 NAT64 prefix' };
  // 2002::/16 — 6to4, likewise an IPv4 destination in disguise.
  if (lowered.startsWith('2002:')) return { allowed: false, reason: 'IPv6 6to4 prefix' };

  return ALLOWED;
}

export function isPublicIpAddress(address: string): boolean {
  return inspectIpAddress(address).allowed;
}
