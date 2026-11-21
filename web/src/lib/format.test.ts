import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsed, msBetween, plural } from './format';

describe('formatDuration', () => {
  it('uses tenths of a second under ten seconds', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(420)).toBe('0.4s');
    expect(formatDuration(3249)).toBe('3.2s');
    expect(formatDuration(9999)).toBe('9.9s');
  });

  it('uses whole seconds, minutes and hours above that', () => {
    expect(formatDuration(10_000)).toBe('10s');
    expect(formatDuration(59_999)).toBe('59s');
    expect(formatDuration(72_000)).toBe('1m 12s');
    expect(formatDuration(3_600_000 + 5 * 60_000 + 7000)).toBe('1h 5m');
  });

  it('treats negative and non-finite input as zero', () => {
    expect(formatDuration(-5)).toBe('0.0s');
    expect(formatDuration(Number.NaN)).toBe('0.0s');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0.0s');
  });
});

describe('formatElapsed', () => {
  it('formats whole seconds for live timers', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(999)).toBe('0s');
    expect(formatElapsed(42_500)).toBe('42s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(7_260_000)).toBe('2h 1m');
    expect(formatElapsed(-1000)).toBe('0s');
  });
});

describe('msBetween', () => {
  it('returns the difference between two timestamps', () => {
    expect(msBetween('2026-01-01T00:00:00.000Z', '2026-01-01T00:01:12.000Z')).toBe(72_000);
  });

  it('returns null for missing or invalid input and clamps negatives', () => {
    expect(msBetween(null, '2026-01-01T00:00:00Z')).toBeNull();
    expect(msBetween('2026-01-01T00:00:00Z', undefined)).toBeNull();
    expect(msBetween('nope', '2026-01-01T00:00:00Z')).toBeNull();
    expect(msBetween('2026-01-01T00:00:05Z', '2026-01-01T00:00:00Z')).toBe(0);
  });
});

describe('plural', () => {
  it('chooses the singular only for exactly one', () => {
    expect(plural(0, 'round')).toBe('0 rounds');
    expect(plural(1, 'round')).toBe('1 round');
    expect(plural(2, 'reply', 'replies')).toBe('2 replies');
  });
});
