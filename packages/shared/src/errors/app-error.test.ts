import { describe, expect, it } from 'vitest';
import { AppError, describeError } from './app-error.js';

class TestError extends AppError {
  readonly code = 'TEST';
}

describe('describeError', () => {
  it('names the error and its message', () => {
    expect(describeError(new TypeError('nope'))).toBe('TypeError: nope');
  });

  it('follows the cause chain', () => {
    // The regression. Drizzle wraps a driver failure in an error whose own
    // message is the entire SQL statement and its parameters, while the
    // sentence that explains the failure sits one level down. Printing only the
    // top frame produced four thousand characters of log that said nothing.
    const driver = new Error('invalid input value for enum media_platform: "youtube"');
    const wrapped = new Error('Failed query: insert into "download_jobs" ...', { cause: driver });

    const described = describeError(wrapped);

    expect(described).toContain('Failed query');
    expect(described).toContain('invalid input value for enum media_platform');
  });

  it('follows several levels', () => {
    const root = new Error('ECONNREFUSED');
    const middle = new Error('pool acquire failed', { cause: root });
    const top = new Error('query failed', { cause: middle });

    expect(describeError(top)).toContain('ECONNREFUSED');
  });

  it('stops before an unbounded or cyclic chain', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    // A cycle would loop forever without the depth cap.
    (first as { cause?: unknown }).cause = second;

    const described = describeError(second);
    expect(described.length).toBeLessThan(500);
  });

  it('keeps working for an AppError with a cause', () => {
    const described = describeError(new TestError('outer', { cause: new Error('inner') }));
    expect(described).toBe('TestError: outer <- Error: inner');
  });

  it('handles values that are not errors', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(describeError(undefined)).toBe(String(undefined));
  });
});
