import { placeTokensIn, scrubContactTokens, scrubPlaceTokens } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { deidentifyActivitySubject } from '~/lib/channel/activity/deidentify';
import { deidentifyLiveQuery } from '~/lib/channel/intake/live-lookup';
import { deidentifyOfficialQuery } from '~/lib/channel/intake/official-page';
import { scrubDirectIdentifiers } from '~/lib/channel/off-domain/answer-request';
import { scrubResidualPii } from '~/lib/channel/off-domain/medical';
import { validateReplyCopy } from '~/lib/channel/reply-copy/validate';
import { haleMask } from '~/lib/telemetry/mask';

// Fixture codes are shaped like real ones and are not assigned: no ZIP is 99999 or 00000,
// and no Canadian code starts with Z.

/** Each way a parent might type a place code, and the code's digits or letters that must
 * not survive. */
const EVASIONS: readonly [string, string, string][] = [
  ['bare ZIP', 'swim near 99999', '99999'],
  ['ZIP+4', 'swim near 99999-0000', '99999'],
  ['ZIP+4 tail', 'swim near 99999-0000', '0000'],
  ['ZIP after a state', 'swim in WA 99999', '99999'],
  ['ZIP at the start', '99999 swim lessons', '99999'],
  ['full-width digits', 'swim near ９９９９９', '９９９９９'],
  ['spaced digits', 'swim near 9 9 9 9 9', '9 9 9 9 9'],
  ['dotted digits', 'swim near 0.0.0.0.0', '0.0.0.0.0'],
  ['ZIP glued to a word before', 'swim near99999', '99999'],
  ['ZIP glued to a word after', 'swim 99999please', '99999'],
  ['zero-width space inside', 'swim near 999​99', '999'],
  ['en dash in ZIP+4', 'swim near 99999–0000', '0000'],
  ['Canadian code', 'swim near Z9Z 9Z9', 'Z9Z'],
  ['Canadian code, no space, lower case', 'swim near z9z9z9', 'z9z'],
  ['Canadian code, full-width', 'swim near Ｚ９Ｚ ９Ｚ９', '９Ｚ９'],
  ['Canadian FSA', 'swim near Z9Z', 'Z9Z'],
  ['first ZIP of a comma list', 'swim near 99999,00000', '99999'],
  ['second ZIP of a comma list', 'swim near 99999,00000', '00000'],
  ['Canadian code glued to a word before', 'swim nearZ9Z 9Z9', 'Z9Z'],
  ['Canadian code glued to a word after', 'swim Z9Z9Z9please', 'Z9Z'],
  ['Canadian code, one character at a time', 'swim near Z 9 Z 9 Z 9', 'Z 9 Z'],
  ['ZIP split by a space', 'swim near 999 99', '999'],
];

/** What must come through: a price, a grouped figure, a decimal, a year, small numbers. */
const SURVIVES: readonly string[] = [
  '$12345 budget',
  '$ 12345 budget',
  '12345 dollars for camp',
  '12,345 kids signed up',
  '12345.50 for the season',
  '12345,50 for the season',
  'ages 3 5 7 9 11',
  'swim opens March 3 2027',
  'swim in 2027',
  'ages 10 12 14',
  'a 3 hour drive',
];

describe('scrubPlaceTokens', () => {
  it.each(EVASIONS)('takes out a %s', (_label, text, leaked) => {
    const out = scrubPlaceTokens(text, '');
    expect(out).not.toContain(leaked);
    expect(out).toContain('swim');
  });

  it.each(SURVIVES)('leaves survivor %# as typed', (text) => {
    expect(scrubPlaceTokens(text, '[x]')).toBe(text);
  });

  it('replaces each code once, and keeps the rest as typed', () => {
    expect(scrubPlaceTokens('swim near 99999-0000 or Z9Z 9Z9, $12345', '[x]')).toBe(
      'swim near [x] or [x], $12345',
    );
  });
});

describe('scrubContactTokens', () => {
  it.each([
    ['an email', 'swim, email pat@example.com', 'example'],
    ['a full-width email', 'swim, email ｐａｔ＠ｅｘａｍｐｌｅ．ｃｏｍ', 'ｅｘａｍｐｌｅ'],
    ['a phone number', 'swim, call 555 555 0123', '0123'],
    ['a full-width phone number', 'swim, call ５５５ ５５５ ０１２３', '０１２３'],
    ['a phone number in another script', 'swim, call ٥٥٥ ٥٥٥ ٠١٢٣', '٠١٢٣'],
  ])('takes out %s', (_label, text, leaked) => {
    const out = scrubContactTokens(text, '');
    expect(out).not.toContain(leaked);
    expect(out).toContain('swim');
  });

  it('leaves a sentence with no contact as typed', () => {
    expect(scrubContactTokens('swim on 3 days for $120', '[x]')).toBe('swim on 3 days for $120');
  });
});

describe('placeTokensIn', () => {
  it('names each code as it was typed', () => {
    expect(placeTokensIn('near ９９９９９ and Z9Z')).toEqual(['９９９９９', 'Z9Z']);
  });

  it('finds nothing in a price', () => {
    expect(placeTokensIn('$12345 budget')).toEqual([]);
  });
});

/** The query an intake scrub hands on. With no child names it never refuses. */
function searched(scrub: { ok: true; text: string } | { ok: false }): string {
  if (!scrub.ok) throw new Error('the scrub refused a text with no child name');
  return scrub.text;
}

/** Every place text leaves Hale through, scrubbed by the one matcher. */
const SITES: readonly [string, (text: string) => string][] = [
  ['intake live lookup', (text) => searched(deidentifyLiveQuery(text, []))],
  ['intake official page', (text) => searched(deidentifyOfficialQuery(text, []))],
  ['medical and activity searches', scrubResidualPii],
  ['general answer search', scrubDirectIdentifiers],
  ['trace mask, prose', (text) => haleMask({ data: text })],
  ['trace mask, JSON', (text) => haleMask({ data: JSON.stringify({ question: text }) })],
];

describe.each(SITES)('%s', (_site, scrub) => {
  it('takes out a bare ZIP and a ZIP+4', () => {
    expect(scrub('swim near 99999')).not.toContain('99999');
    const plus4 = scrub('swim near 99999-0000');
    expect(plus4).not.toContain('99999');
    expect(plus4).not.toContain('0000');
  });

  it('takes out a Canadian code', () => {
    expect(scrub('swim near Z9Z 9Z9')).not.toContain('Z9Z');
  });

  it('keeps a price', () => {
    expect(scrub('swim with a $12345 budget')).toContain('$12345 budget');
  });

  it.each([
    ['a12345@example.com', ['a12345', 'example']],
    ['pat.doe12345@example.org', ['pat', 'doe', 'example']],
    ['sam.a1b@example.net', ['sam', 'a1b', 'example']],
  ])('takes out the whole of an email whose local part looks like a place (%s)', (email, parts) => {
    const out = scrub(`email ${email} about swim`);
    expect(out).toContain('swim');
    expect(out).not.toContain('@');
    for (const part of parts) expect(out).not.toContain(part);
  });
});

/** The searches that strip contacts by the same scrub: the intake ones and the activity
 * and medical backstop. */
const CONTACT_SITES = SITES.slice(0, 3);

describe.each(CONTACT_SITES)('%s', (_site, scrub) => {
  it('takes out a full-width email and phone number', () => {
    const out = scrub('swim, write ｐａｔ＠ｅｘａｍｐｌｅ．ｃｏｍ or call ５５５ ５５５ ０１２３');
    expect(out).toContain('swim');
    expect(out).not.toContain('ｅｘａｍｐｌｅ');
    expect(out).not.toContain('０１２３');
  });

  it("takes out a phone number in another script's digits", () => {
    const out = scrub('swim, call ٥٥٥ ٥٥٥ ٠١٢٣');
    expect(out).toContain('swim');
    expect(out).not.toContain('٠١٢٣');
  });
});

/** Every search a family's words reach, each through the one normalising scrub. */
const SEARCH_SITES: readonly [string, (text: string) => string][] = [
  ...SITES.slice(0, 4),
  [
    'activity and travel searches',
    (text) => {
      const gated = deidentifyActivitySubject(text, []);
      if (!gated.ok) throw new Error(`the activity gate refused: ${gated.refusal}`);
      return gated.value;
    },
  ],
];

/** The test's own reading of a text, written apart from the scrub's: compatibility form
 * with accents, zero-width and format characters dropped, any run of space as one space,
 * lower case. */
function plainly(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

/** A code or a contact typed so that it reads as itself once normalised, and what of it
 * must not reach a search. */
const SEARCH_EVASIONS: readonly [string, string, readonly string[]][] = [
  ['Canadian code with a combining accent', 'swim near Ź9Z 9Z9', ['z9z', '9z9']],
  ['Canadian code in accented letters', 'swim near Ź9Ź 9Ź9', ['z9z', '9z9']],
  ['Canadian code split by a tab', 'swim near Z9Z\t9Z9', ['z9z', '9z9']],
  ['Canadian code split by an ideographic space', 'swim near Z9Z　9Z9', ['z9z', '9z9']],
  ['ZIP in keycap emoji', 'swim near 9️⃣9️⃣9️⃣9️⃣9️⃣', ['99999']],
  ['ZIP with a word joiner inside', 'swim near 999⁠99', ['99999']],
  ['ZIP in circled digits', 'swim near ⑨⑨⑨⑨⑨', ['99999']],
  ['ZIP in superscript digits', 'swim near ⁹⁹⁹⁹⁹', ['99999']],
  ['email with an accented local part', 'swim, write pàt@example.com', ['example', '@']],
  ['email with a zero-width space in it', 'swim, write pat@exa​mple.com', ['example', '@']],
  ['phone number in parentheses form', 'swim, call (555) 555-0123', ['555', '0123']],
  ['phone number with en dashes', 'swim, call 555–555–0123', ['555', '0123']],
];

describe.each(SEARCH_SITES)('%s, typed to slip past', (_site, scrub) => {
  it.each(SEARCH_EVASIONS)('takes out a %s', (_label, typed, leaked) => {
    // Positive control: the test's reading sees every part in the text as typed, so its
    // absence below is the scrub's doing and not a blind check.
    for (const part of leaked) expect(plainly(typed)).toContain(part);
    const out = plainly(scrub(typed));
    expect(out).toContain('swim');
    for (const part of leaked) expect(out).not.toContain(part);
  });

  it('hands on accented words as typed, accents and all', () => {
    expect(scrub('natation à Montréal, École de danse')).toBe(
      'natation à Montréal, École de danse',
    );
  });
});

describe('trace mask', () => {
  it('keeps a JSON number, which is not a place', () => {
    expect(haleMask({ data: JSON.stringify({ input_tokens: 12345 }) })).toBe(
      '{"input_tokens":12345}',
    );
  });

  it('takes out a postal code or a ZIP used as a key', () => {
    const out = haleMask({ data: JSON.stringify({ data: { 'Z9Z 9Z9': 'x', '99999': 1 } }) });
    expect(out).not.toContain('Z9Z');
    expect(out).not.toContain('99999');
    expect(out).toContain('[REDACTED_POSTAL]');
  });

  it('takes a five-digit house number with its street', () => {
    const out = haleMask({ data: 'we are at 12345 Maple Street' });
    expect(out).not.toContain('Maple');
    expect(out).toContain('[REDACTED_ADDRESS]');
  });
});

describe('reply check', () => {
  const check = {
    language: 'en',
    audience: 'direct' as const,
    questionAllowed: true,
    role: 'prose' as const,
  };

  it('refuses a ZIP the facts never gave, typed in digits the digit rule cannot read', () => {
    expect(validateReplyCopy('Swim near ９９９９９ is open.', { ...check, facts: [] })).toBe(
      'place',
    );
  });

  it('accepts the same ZIP when the facts gave it (positive control)', () => {
    expect(
      validateReplyCopy('Swim near ９９９９９ is open.', { ...check, facts: ['near ９９９９９'] }),
    ).toBeNull();
  });
});
