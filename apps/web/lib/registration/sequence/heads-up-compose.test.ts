import { describe, expect, it } from 'vitest';
import { headsUpRefusals } from './heads-up-compose';

describe('VIL-488 · headsUpRefusals', () => {
  it('refuses an empty draft and any link', () => {
    expect(headsUpRefusals('  ')).toEqual(['empty']);
    expect(headsUpRefusals('Opens Tuesday. https://example.com')).toEqual(['link']);
  });
  it('passes a plain text', () => {
    expect(
      headsUpRefusals('Richmond Hill fall programs open Tuesday at 6:30 a.m. for Max.'),
    ).toEqual([]);
  });
});
