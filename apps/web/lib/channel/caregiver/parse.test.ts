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

  it.each(['partner', 'spouse', 'wife', 'husband', 'co-parent', 'co parent', 'coparent'])(
    'reads the partner word "%s" as a co_parent add (VIL-355)',
    (word) => {
      expect(parseAddCaregiver(`add Sam 647-555-0199 as ${word}`)).toEqual({
        ok: true,
        name: 'Sam',
        phoneE164: '+16475550199',
        role: 'co_parent',
      });
    },
  );

  /**
   * The wording the feature was specified around: a parent writes "as MY partner", not
   * "as partner". The determiner is dropped before the lookup, so one table entry covers
   * both — and it covers the caregiver words for free, which is how the sentence reads.
   */
  it('drops the determiner a parent actually writes in front of the relationship', () => {
    expect(parseAddCaregiver('add Sam 647-555-0199 as my partner')).toEqual({
      ok: true,
      name: 'Sam',
      phoneE164: '+16475550199',
      role: 'co_parent',
    });
    expect(parseAddCaregiver('add Nana 647-555-0199 as our nanny')).toEqual({
      ok: true,
      name: 'Nana',
      phoneE164: '+16475550199',
      role: 'nanny',
    });
    // And it cannot widen what is grantable: the word behind the determiner goes through
    // the same two closed tables.
    expect(parseAddCaregiver('add Sam 647-555-0199 as my parent')).toEqual({
      ok: false,
      reason: 'unsupported_role',
    });
  });

  /**
   * "as parent" is the one word VIL-355 leaves refused. It is what a parent writes about
   * a grandparent, a step-parent and their own partner alike, and the seat behind it is
   * the whole family surface — so the ambiguous word keeps the redirect and the specific
   * ones get the flow.
   */
  it('keeps bare "parent" refused — too weak a word to seat a full-scope member', () => {
    expect(parseAddCaregiver('add Sam 647-555-0199 as parent')).toEqual({
      ok: false,
      reason: 'unsupported_role',
    });
  });

  /**
   * THE TABLES ARE CLOSED, and a prototype key is not a word in them. The role pattern
   * admits `constructor` and the lookup normalizes to lower case, so a plain-object
   * `CO_PARENT_WORDS[roleWord]` handed back `Object.prototype.constructor` — truthy, and
   * typed as a role. It refused only because a different guard ran first.
   */
  it.each(['constructor', 'valueof', 'tostring', 'hasownproperty'])(
    'reads the inherited key %s as no role at all',
    (word) => {
      expect(parseAddCaregiver(`add Sam 647-555-0199 as ${word}`)).toEqual({
        ok: false,
        reason: 'unparseable',
      });
    },
  );

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
    expect(looksLikeAddCommand('add grandma 647-555-0199 as grandparent')).toBe(true);
    expect(looksLikeAddCommand('  ADD my mum 647 555 0199 As Nanny')).toBe(true);
    // The shape is there but the role word is not — still a caregiver attempt, and it
    // is owed the example rather than a conversation about story time.
    expect(looksLikeAddCommand('add grandma 647-555-0199 as chauffeur')).toBe(true);
    expect(looksLikeAddCommand('added the swim class already')).toBe(false);
    expect(looksLikeAddCommand('can you add soccer on saturday')).toBe(false);
  });

  /**
   * VIL-355 widened the role words, not the SHAPE. The two sentences a parent is most
   * likely to write about a partner still have to go where they went before: the
   * numberless one to the forwardable link (join/parse.ts), and the one about somebody
   * else's dentist to the coach.
   */
  it('leaves the numberless partner ask and a possessive to the paths that own them', () => {
    expect(looksLikeAddCommand('add my partner')).toBe(false);
    expect(looksLikeAddCommand("add my partner's dentist")).toBe(false);
  });

  /**
   * The headline VIL-260 defect: "add" is the most ordinary verb a parent uses about
   * their calendar, and claiming the whole prefix meant every one of those messages was
   * answered with a caregiver example and never reached the coach.
   *
   * A caregiver command has a SHAPE nothing else does — a real NANP number AND the
   * literal " as " that separates the name from the role. Both, or it is conversation.
   */
  it.each([
    ['the headline toddler ask', 'Add library story time Saturday 10am'],
    ['a calendar ask with a time', 'add swim Thursday at 4:30'],
    ['an "as" with no number', 'add gymnastics as a weekly thing'],
    ['a number with no "as"', 'add my mum 647 555 0199'],
    ['a date that is not a phone number', 'add the deadline 2026-08-01 as a reminder'],
    ['a bare fragment', 'add grandma'],
    // Deliberate: a number we could never text is not evidence of a caregiver command,
    // and the coach answering conversationally beats an invite example nobody can use.
    ['a number that is not a real CA/US line', 'add grandma 123-456-7890 as grandparent'],
  ])('leaves %s to the coach', (_label, body) => {
    expect(looksLikeAddCommand(body)).toBe(false);
  });
});
