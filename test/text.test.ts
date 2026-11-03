import { describe, expect, it } from 'vitest';
import { TextIndex, tokenize } from '../src/text.js';

describe('tokenize', () => {
  it('drops stopwords and folds simple plurals and tenses', () => {
    expect(tokenize('Fix the crashes')).toEqual(['fix', 'crash']);
    expect(tokenize('fixing tests')).toEqual(['fix', 'test']);
  });
});

describe('TextIndex', () => {
  const index = new TextIndex(['add rate limiting to the api', 'fix login crash', 'add dark mode', '']);

  it('ranks the document sharing rare terms first', () => {
    const scores = index.scores('rate limiting');
    expect(scores.get(0)).toBeGreaterThan(0.3);
    expect(scores.has(1)).toBe(false);
  });

  it('scores an identical document near 1', () => {
    expect(index.scores('fix login crash').get(1)).toBeCloseTo(1, 6);
  });

  it('returns nothing for unseen or empty text', () => {
    expect(index.scores('zebra').size).toBe(0);
    expect(index.scores('').size).toBe(0);
  });
});
