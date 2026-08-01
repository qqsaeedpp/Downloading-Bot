import { randomUUID, randomBytes } from 'node:crypto';

/**
 * Identity as a dependency, for the same reason as {@link Clock}: a test that
 * asserts on an id should not have to guess it.
 */
export interface IdGenerator {
  /** RFC 4122 v4, lowercase. */
  uuid(): string;
  /** Short, URL- and callback-data-safe token. */
  short(length?: number): string;
}

/** Crockford-style alphabet: no I, L, O or U, so a token cannot read as a word. */
const SHORT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export class CryptoIdGenerator implements IdGenerator {
  uuid(): string {
    return randomUUID();
  }

  short(length = 10): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      // `bytes` is exactly `length` long and the modulo keeps the index in
      // range, but noUncheckedIndexedAccess cannot know either — and a `!` here
      // would be a lie waiting to become true.
      const byte = bytes[i] ?? 0;
      out += SHORT_ALPHABET[byte % SHORT_ALPHABET.length] ?? '0';
    }
    return out;
  }
}

/** Test double producing predictable, still-unique identifiers. */
export class SequentialIdGenerator implements IdGenerator {
  #counter = 0;

  constructor(private readonly prefix = '00000000-0000-4000-8000-') {}

  uuid(): string {
    this.#counter += 1;
    return `${this.prefix}${this.#counter.toString(16).padStart(12, '0')}`;
  }

  short(length = 10): string {
    this.#counter += 1;
    return this.#counter.toString(36).toUpperCase().padStart(length, '0').slice(0, length);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
