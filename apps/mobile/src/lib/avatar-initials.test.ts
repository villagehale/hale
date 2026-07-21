import { describe, expect, it } from 'vitest';
import { avatarInitials } from './avatar-initials';

/**
 * The initials shown when there is no avatar photo. Derived from the spec: a name plus a
 * second part (a child's last name) gives two upper-cased letters; a name alone gives
 * one; an empty/absent name falls back to a neutral placeholder. Never throws.
 */
describe('avatarInitials', () => {
  it('combines a name and a second part into two upper-cased letters', () => {
    expect(avatarInitials('Maya', 'Chen')).toBe('MC');
    expect(avatarInitials('maya', 'chen')).toBe('MC');
  });

  it('uses one letter for a name with no second part', () => {
    expect(avatarInitials('Maya')).toBe('M');
    expect(avatarInitials('  alex  ')).toBe('A');
  });

  it('falls back to the second part when the name is absent', () => {
    expect(avatarInitials(null, 'Chen')).toBe('C');
    expect(avatarInitials('', 'Chen')).toBe('C');
  });

  it('returns a neutral placeholder when there is nothing to show', () => {
    expect(avatarInitials(null)).toBe('?');
    expect(avatarInitials('', '')).toBe('?');
    expect(avatarInitials('   ')).toBe('?');
  });
});
