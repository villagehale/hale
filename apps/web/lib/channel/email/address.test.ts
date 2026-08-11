import { describe, expect, it } from 'vitest';
import { domainOf, parseEmailAddress } from './address';

describe('parseEmailAddress', () => {
  it('reads a bare address', () => {
    expect(parseEmailAddress('parent@example.com')).toEqual({
      address: 'parent@example.com',
      domain: 'example.com',
      displayName: null,
    });
  });

  it('reads the angle-bracket form and keeps the display name separate', () => {
    expect(parseEmailAddress('Sam Rivera <sam@example.com>')).toEqual({
      address: 'sam@example.com',
      domain: 'example.com',
      displayName: 'Sam Rivera',
    });
  });

  it('reads a quoted display name containing a comma', () => {
    expect(parseEmailAddress('"Rivera, Sam" <sam@example.com>')).toEqual({
      address: 'sam@example.com',
      domain: 'example.com',
      displayName: 'Rivera, Sam',
    });
  });

  /**
   * A display name can be set to anything, including another address. The angle
   * brackets are the real sender; a parser that preferred the display name would let
   * `"billing@bank.test" <attacker@evil.test>` read as the bank.
   */
  it('never takes an address out of the display name when angle brackets are present', () => {
    expect(parseEmailAddress('"billing@bank.test" <attacker@evil.test>')?.address).toBe(
      'attacker@evil.test',
    );
    expect(parseEmailAddress('admin@hale.test <attacker@evil.test>')?.address).toBe(
      'attacker@evil.test',
    );
  });

  it('lowercases the whole address so lookups are case-insensitive', () => {
    expect(parseEmailAddress('Sam.Rivera@Example.COM')).toEqual({
      address: 'sam.rivera@example.com',
      domain: 'example.com',
      displayName: null,
    });
  });

  /**
   * Deliberately NOT canonicalized: Gmail dot-folding and `+tag` stripping are
   * provider-specific conventions, and applying them universally would collapse two
   * genuinely different mailboxes at other providers into one identity.
   */
  it('preserves plus tags and dots rather than folding two mailboxes into one', () => {
    expect(parseEmailAddress('sam+hale@example.com')?.address).toBe('sam+hale@example.com');
    expect(parseEmailAddress('s.a.m@example.com')?.address).toBe('s.a.m@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(parseEmailAddress('  sam@example.com  ')?.address).toBe('sam@example.com');
    expect(parseEmailAddress(' Sam <  sam@example.com  > ')?.address).toBe('sam@example.com');
  });

  it('returns null for anything that is not one routable address', () => {
    for (const bad of ['', '   ', 'not-an-address', '@example.com', 'sam@', 'sam@@example.com']) {
      expect(parseEmailAddress(bad)).toBeNull();
    }
  });

  it('returns null for a domain with no dot, which cannot be a real sender', () => {
    expect(parseEmailAddress('root@localhost')).toBeNull();
  });

  it('rejects an address carrying a comma or a second address', () => {
    expect(parseEmailAddress('a@example.com, b@example.com')).toBeNull();
  });

  it('rejects whitespace inside the address itself', () => {
    expect(parseEmailAddress('sam rivera@example.com')).toBeNull();
  });
});

describe('domainOf', () => {
  it('returns the lowercased domain', () => {
    expect(domainOf('Sam@Example.COM')).toBe('example.com');
  });

  it('returns empty string when there is no domain to read', () => {
    expect(domainOf('nonsense')).toBe('');
  });
});
