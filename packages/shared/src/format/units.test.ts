import { describe, expect, it } from 'vitest';
import {
  bytesToMegabytes,
  formatBytes,
  formatDuration,
  megabytesToBytes,
  renderProgressBar,
} from './units.js';

const MIB = 1024 * 1024;

describe('formatBytes', () => {
  it('reports sub-kilobyte sizes as whole bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('rounds a fractional byte count rather than printing a decimal byte', () => {
    expect(formatBytes(511.6)).toBe('512 B');
  });

  it('switches to the next unit at exactly 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('formats megabytes and gigabytes with one fraction digit by default', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * MIB)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 * MIB)).toBe('2.0 GB');
  });

  it('honours a caller-supplied precision', () => {
    expect(formatBytes(1536, 2)).toBe('1.50 KB');
    expect(formatBytes(1536, 0)).toBe('2 KB');
  });

  it('stops at terabytes instead of inventing a larger unit', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });

  it('returns the em dash placeholder for a negative size', () => {
    expect(formatBytes(-1)).toBe('—');
  });

  it('returns the em dash placeholder for NaN and Infinity', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('renders zero seconds as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('zero-pads the seconds but not the leading minutes', () => {
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(93)).toBe('1:33');
  });

  it('adds an hours component only once the duration passes an hour', () => {
    expect(formatDuration(3599)).toBe('59:59');
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('zero-pads minutes once hours are present', () => {
    expect(formatDuration(3661)).toBe('1:01:01');
  });

  it('handles durations longer than a day without wrapping the hour count', () => {
    expect(formatDuration(90_061)).toBe('25:01:01');
  });

  it('rounds fractional seconds to the nearest whole second', () => {
    expect(formatDuration(59.4)).toBe('0:59');
    expect(formatDuration(59.6)).toBe('1:00');
  });

  it('returns the em dash placeholder for negative and non-finite input', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('renderProgressBar', () => {
  it('renders an entirely empty bar of the default width when progress is unknown', () => {
    const bar = renderProgressBar(undefined);

    expect(bar).toBe('░'.repeat(10));
    expect(bar).toHaveLength(10);
    expect(bar).not.toContain('█');
  });

  it('respects a custom width when progress is unknown', () => {
    expect(renderProgressBar(undefined, 5)).toBe('░░░░░');
  });

  it('renders an empty bar for NaN progress instead of a broken one', () => {
    expect(renderProgressBar(Number.NaN)).toBe('░'.repeat(10));
  });

  it('renders an empty bar at 0% and a full bar at 100%', () => {
    expect(renderProgressBar(0)).toBe('░'.repeat(10));
    expect(renderProgressBar(100)).toBe('█'.repeat(10));
  });

  it('fills proportionally, rounding to the nearest cell', () => {
    expect(renderProgressBar(50)).toBe('█████░░░░░');
    expect(renderProgressBar(33)).toBe('███░░░░░░░');
  });

  it('clamps a percentage above 100 to a full bar', () => {
    expect(renderProgressBar(150)).toBe('█'.repeat(10));
  });

  it('clamps a negative percentage to an empty bar', () => {
    expect(renderProgressBar(-20)).toBe('░'.repeat(10));
  });

  it('always returns exactly `width` cells', () => {
    for (const percent of [0, 7, 42, 99.9, 100]) {
      expect(renderProgressBar(percent, 20)).toHaveLength(20);
    }
  });
});

describe('megabytesToBytes / bytesToMegabytes', () => {
  it('converts megabytes using binary units', () => {
    expect(megabytesToBytes(1)).toBe(1_048_576);
    expect(megabytesToBytes(50)).toBe(52_428_800);
    expect(megabytesToBytes(500)).toBe(524_288_000);
  });

  it('floors a fractional megabyte to a whole byte count', () => {
    expect(megabytesToBytes(1.5)).toBe(1_572_864);
    expect(megabytesToBytes(0.000_000_5)).toBe(0);
  });

  it('maps zero to zero', () => {
    expect(megabytesToBytes(0)).toBe(0);
    expect(bytesToMegabytes(0)).toBe(0);
  });

  it('converts bytes back to megabytes, keeping the fraction', () => {
    expect(bytesToMegabytes(1_048_576)).toBe(1);
    expect(bytesToMegabytes(1_572_864)).toBe(1.5);
  });

  it('round-trips a whole number of megabytes', () => {
    expect(bytesToMegabytes(megabytesToBytes(250))).toBe(250);
  });
});
