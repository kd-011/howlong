import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../src/format.js';

describe('parseDuration', () => {
  it.each([
    ['45m', 45 * 60_000],
    ['1h30m', 90 * 60_000],
    ['1h 30m', 90 * 60_000],
    ['2.5h', 150 * 60_000],
    ['90s', 90_000],
    ['1d', 86_400_000],
  ])('reads %s', (text, ms) => expect(parseDuration(text)).toBe(ms));

  it.each(['45', '', 'soon', '5x', 'm5', '-5m'])('refuses %j', (text) => {
    expect(() => parseDuration(text)).toThrow(/Cannot read/);
  });
});

describe('formatDuration', () => {
  it.each([
    [10_000, '<1m'],
    [60_000, '1m'],
    [45 * 60_000, '45m'],
    [60 * 60_000, '1h'],
    [85 * 60_000, '1h 25m'],
    [24 * 60 * 60_000, '1d'],
    [27 * 60 * 60_000, '1d 3h'],
  ])('renders %d as %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});
