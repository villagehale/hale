import { describe, expect, it } from 'vitest';
import { childInitials } from './child-initials.js';

describe('childInitials', () => {
  it('is the first-name initial alone when there is no last name', () => {
    expect(childInitials('Maya')).toBe('M');
    expect(childInitials('Maya', null)).toBe('M');
  });

  it('is first + last initial when a last name is present', () => {
    expect(childInitials('Maya', 'Vega')).toBe('MV');
  });

  it('uppercases both initials regardless of input case', () => {
    expect(childInitials('maya', 'vega')).toBe('MV');
    expect(childInitials('maya')).toBe('M');
  });

  it('trims surrounding whitespace before taking initials', () => {
    expect(childInitials('  Maya  ', '  Vega  ')).toBe('MV');
  });

  it('treats an empty or whitespace-only last name as no last name (first initial only)', () => {
    expect(childInitials('Maya', '')).toBe('M');
    expect(childInitials('Maya', '   ')).toBe('M');
  });

  it('never borrows a surname — a child with no last name gets ONLY their first initial (blended-family safety, rule #1)', () => {
    // The signature carries no parent/family surname by design: the last initial can
    // come ONLY from the child's own stored lastName. A child logged first-name-only
    // must render a single initial, never a second letter from anywhere else.
    expect(childInitials('Sam', null)).toBe('S');
    expect(childInitials('Sam', undefined)).toBe('S');
  });

  it('takes the first code point of accented / non-ASCII names, uppercased', () => {
    expect(childInitials('élodie')).toBe('É');
    expect(childInitials('élodie', 'órla')).toBe('ÉÓ');
  });

  it('does not split a surrogate pair (emoji name keeps its whole glyph)', () => {
    expect(childInitials('🦊 fox')).toBe('🦊');
  });

  it('falls back to a neutral placeholder for an empty name', () => {
    expect(childInitials('')).toBe('?');
    expect(childInitials('   ', '   ')).toBe('?');
  });
});
