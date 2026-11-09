import { describe, expect, it } from 'vitest';
import { deidentifyLiveQuery } from '~/lib/channel/intake/live-lookup';
import { deidentifyOfficialQuery } from '~/lib/channel/intake/official-page';
import { scrubDirectIdentifiers } from '~/lib/channel/off-domain/answer-request';
import { scrubResidualPii } from '~/lib/channel/off-domain/medical';
import { validateReplyCopy } from '~/lib/channel/reply-copy/validate';
import { haleMask } from '~/lib/telemetry/mask';
import { placeTokensIn, scrubPlaceTokens } from './place-token';

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
];

/** What must come through: a price, a grouped figure, a decimal, a year, small numbers. */
const SURVIVES: readonly string[] = [
  '$12345 budget',
  '$ 12345 budget',
  '12345 dollars for camp',
  '12,345 kids signed up',
  '12345.50 for the season',
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
});

describe('trace mask', () => {
  it('keeps a JSON number, which is not a place', () => {
    expect(haleMask({ data: JSON.stringify({ input_tokens: 12345 }) })).toBe(
      '{"input_tokens":12345}',
    );
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
