import { describe, expect, it } from 'vitest';
import { generateSessions } from '../src/synthetic.js';

describe('generateSessions', () => {
  it('repeats exactly for a seed and differs across seeds', () => {
    expect(generateSessions(50, 1)).toEqual(generateSessions(50, 1));
    expect(generateSessions(50, 1)).not.toEqual(generateSessions(50, 2));
  });

  it('keeps turns in order and inside the session', () => {
    for (const s of generateSessions(100)) {
      expect(s.turns[0]![0]).toBe(s.startedAt);
      for (const [a, b] of s.turns) expect(b).toBeGreaterThan(a);
    }
  });
});
