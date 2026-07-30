import { describe, expect, it } from 'vitest';
import { looksLikeAddCommand, parseAddCaregiver } from './parse';

describe('caregiver · parsing the add command', () => {
  it('reads the name, the number and the role from the canonical phrasing', () => {
    expect(parseAddCaregiver('add grandma 647-555-0199 as grandparent')).toEqual({
      ok: true,
      name: 'grandma',
      phoneE164: '+16475550199',
      role: 'grandparent',
    });
  });

  it('accepts a spaced, +1-prefixed number and an odd case', () => {
    expect(parseAddCaregiver('  Add Nana +1 647 555 0199 As Nanny ')).toEqual({
      ok: true,
      name: 'Nana',
      phoneE164: '+16475550199',
      role: 'nanny',
    });
  });

  it.each([
    ['grandparent', 'grandparent'],
    ['grandma', 'grandparent'],
    ['grandpa', 'grandparent'],
    ['nanny', 'nanny'],
    ['babysitter', 'babysitter'],
    ['sitter', 'babysitter'],
  ])('maps the role word "%s" to %s', (word, role) => {
    const parsed = parseAddCaregiver(`add Sam 416-555-0143 as ${word}`);
    expect(parsed).toMatchObject({ ok: true, role });
  });

  it('accepts a multi-word name', () => {
    expect(parseAddCaregiver("add Auntie Jo-Anne O'Neil 416-555-0143 as babysitter")).toMatchObject(
      { ok: true, name: "Auntie Jo-Anne O'Neil" },
    );
  });

  it('turns a co-parent request away with its own reason, not a generic failure', () => {
    expect(parseAddCaregiver('add Sam 647-555-0199 as co-parent')).toEqual({
      ok: false,
      reason: 'unsupported_role',
    });
    expect(parseAddCaregiver('add Sam 647-555-0199 as coparent')).toEqual({
      ok: false,
      reason: 'unsupported_role',
    });
  });

  it.each([
    ['no number at all', 'add grandma as grandparent'],
    ['no role', 'add grandma 647-555-0199'],
    ['an unknown role word', 'add grandma 647-555-0199 as chauffeur'],
    ['a number that is not a valid CA/US line', 'add grandma 123-456-7890 as grandparent'],
    ['trailing chatter after the role', 'add grandma 647-555-0199 as grandparent please'],
    ['an empty name', 'add 647-555-0199 as grandparent'],
    ['not an add command', 'what is happening on saturday'],
  ])('refuses %s', (_label, body) => {
    expect(parseAddCaregiver(body)).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('refuses an absurdly long name rather than storing it', () => {
    const long = 'a'.repeat(60);
    expect(parseAddCaregiver(`add ${long} 647-555-0199 as nanny`)).toEqual({
      ok: false,
      reason: 'unparseable',
    });
  });

  it('knows when a parent was TRYING to add someone, so silence is never the answer', () => {
    expect(looksLikeAddCommand('add grandma')).toBe(true);
    expect(looksLikeAddCommand('  ADD my mum 647 555 0199')).toBe(true);
    expect(looksLikeAddCommand('added the swim class already')).toBe(false);
    expect(looksLikeAddCommand('can you add soccer on saturday')).toBe(false);
  });
});
