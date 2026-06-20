import { describe, expect, it } from 'vitest';
import { parseInterests } from './children-input.js';

describe('parseInterests', () => {
  it('splits, trims, and drops empty segments', () => {
    expect(parseInterests('swimming, music ,  art ')).toEqual(['swimming', 'music', 'art']);
  });

  it('de-duplicates repeated tags', () => {
    expect(parseInterests('music, music, art')).toEqual(['music', 'art']);
  });

  it('treats undefined or whitespace-only input as no interests', () => {
    expect(parseInterests(undefined)).toEqual([]);
    expect(parseInterests('   ')).toEqual([]);
    expect(parseInterests(',, ,')).toEqual([]);
  });
});
