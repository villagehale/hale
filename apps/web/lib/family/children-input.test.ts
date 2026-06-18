import { describe, expect, it } from 'vitest';
import { normalizeArea, parseInterests } from './children-input.js';

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

describe('normalizeArea', () => {
  it('trims a real area', () => {
    expect(normalizeArea('  M4L ')).toBe('M4L');
  });

  it('clears to null on empty / whitespace (opt-out of local discovery)', () => {
    expect(normalizeArea('')).toBeNull();
    expect(normalizeArea('   ')).toBeNull();
  });
});
