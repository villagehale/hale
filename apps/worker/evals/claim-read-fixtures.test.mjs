import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLAIM_READ_FIXTURES, OFFSET_HOURS, at } from './claim-read-fixtures.mjs';
import {
  READ_CLAIM_KINDS,
  boundViolations,
  compatibleRefs,
  fixtureLeaks,
  privacyViolations,
  provenanceViolations,
} from './lib/claim-read-score.mjs';

/**
 * VIL-581 · the claim-read fixtures are well-formed against the PRODUCTION segmenter and
 * verifier: every gold sentence is exactly one segment, every gold row can back its
 * claim, the per-language minimums and required categories hold, and nothing leaks
 * into the skill or carries private data.
 */

const RECONCILE = new URL('../../web/lib/channel/reconcile/', import.meta.url);
const SKILL = new URL('../../../packages/agent/skills/claim-read.md', import.meta.url);

let segmentSentences;
let claimReadLocale;
let buildClaimCandidates;
let verifyClaimRead;
let BOUNDS;
beforeAll(async () => {
  const candidates = await tsImport(new URL('candidates.ts', RECONCILE).href, import.meta.url);
  const reader = await tsImport(new URL('claim-reader.ts', RECONCILE).href, {
    parentURL: import.meta.url,
    tsconfig: new URL('../../../tsconfig.json', RECONCILE).pathname,
  });
  BOUNDS = {
    body: reader.CLAIM_READ_MAX_BODY_CHARS,
    inbound: reader.CLAIM_READ_MAX_INBOUND_CHARS,
    what: candidates.CLAIM_ROW_MAX_WHAT_CHARS,
    host: candidates.CLAIM_ROW_MAX_HOST_CHARS,
  };
  ({ segmentSentences, claimReadLocale } = await tsImport(
    new URL('sentences.ts', RECONCILE).href,
    import.meta.url,
  ));
  ({ buildClaimCandidates } = await tsImport(
    new URL('candidates.ts', RECONCILE).href,
    import.meta.url,
  ));
  ({ verifyClaimRead } = await tsImport(
    new URL('claim-verdict.ts', RECONCILE).href,
    import.meta.url,
  ));
  // claim-reader.ts pulls in the agent and pipeline graph: a cold CI import of it
  // outlasts the default 10 s hook timeout.
}, 60_000);

const BASE = ['reproducer', 'no_worries', 'reported', 'negation', 'compound', 'arming', 'all_set'];
const MORE = [
  'season_spot',
  'wrong_subject',
  'day_time',
  'injection',
  'true_row',
  'invite',
  'proposal',
];
const REQUIRED = {
  en: [
    ...BASE,
    ...MORE,
    'quotes',
    'spot_open',
    'anaphora',
    'group',
    'private',
    'composer',
    'day_time_compound',
  ],
  fr: [...BASE, ...MORE, 'quotes', 'composer', 'day_time_compound'],
  zh: [...BASE, ...MORE, 'quotes', 'anaphora'],
  es: [...BASE, ...MORE],
  ar: ['reproducer', 'invite', 'proposal', 'arming', 'season_spot', 'true_row'],
};
const MINIMUM = {
  en: { false: 10, true: 20 },
  fr: { false: 10, true: 10 },
  zh: { false: 10, true: 10 },
  es: { false: 10, true: 10 },
  ar: { false: 2, true: 2 },
};
const isFalse = (f) => f.expect.refused.length > 0;

describe('claim-read fixtures', () => {
  it('ids are unique', () => {
    const ids = CLAIM_READ_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every gold sentence is the text of exactly one production segment', () => {
    for (const f of CLAIM_READ_FIXTURES) {
      const texts = segmentSentences(f.body, claimReadLocale(f.language)).map((s) => s.text);
      for (const { sentence } of [...f.expect.claims, ...f.expect.refused]) {
        expect(
          texts.filter((t) => t === sentence),
          `${f.id}: ${sentence}`,
        ).toHaveLength(1);
      }
    }
  });

  it('every gold row names a candidate of a compatible kind', () => {
    for (const f of CLAIM_READ_FIXTURES) {
      const refs = new Set(f.candidates.map((c) => c.ref));
      expect(refs.size, f.id).toBe(f.candidates.length);
      for (const c of f.expect.claims) {
        expect(READ_CLAIM_KINDS, f.id).toContain(c.kind);
        if (c.row !== 'none') {
          expect(compatibleRefs(f, c.kind), `${f.id}: ${c.kind} → ${c.row}`).toContain(c.row);
        }
      }
      for (const ref of f.expect.minted) expect(refs.has(ref), f.id).toBe(true);
    }
  });

  it('a false fixture refuses at least one claim; a true one refuses none (and a gold none is always refused)', () => {
    for (const f of CLAIM_READ_FIXTURES) {
      const unbacked = f.expect.claims.filter((c) => c.row === 'none').map((c) => c.sentence);
      expect([...new Set(unbacked)].sort(), f.id).toEqual(
        [...new Set(f.expect.refused.map((r) => r.sentence))].sort(),
      );
    }
  });

  it('meets the per-language minimums', () => {
    for (const [language, min] of Object.entries(MINIMUM)) {
      const rows = CLAIM_READ_FIXTURES.filter((f) => f.language === language && !f.residual);
      expect(rows.filter(isFalse).length, `${language} false`).toBeGreaterThanOrEqual(min.false);
      expect(rows.filter((f) => !isFalse(f)).length, `${language} true`).toBeGreaterThanOrEqual(
        min.true,
      );
    }
  });

  it('covers every required category in every language the brief marks', () => {
    for (const [language, categories] of Object.entries(REQUIRED)) {
      const present = new Set(
        CLAIM_READ_FIXTURES.filter((f) => f.language === language).map((f) => f.category),
      );
      for (const category of categories)
        expect(present.has(category), `${language} ${category}`).toBe(true);
    }
  });

  it('the zone table converts wall time faithfully (family-local, never a default zone)', () => {
    for (const timeZone of Object.keys(OFFSET_HOURS)) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(at('2026-11-07T10:00', timeZone)));
      expect(parts, timeZone).toBe('2026-11-07, 10:00');
    }
  });
});

describe('the JS compatibility table agrees with the production verifier', () => {
  const SOURCES = [
    { source: 'calendar', kind: 'scheduled_event', startsAt: new Date('2026-11-10T16:00:00Z') },
    { source: 'parent_stated', kind: 'scheduled_event' },
    { source: 'open_commitment', kind: 'registration_watch' },
    { source: 'open_commitment', kind: 'activity_followup' },
    { source: 'watched_page', kind: 'spot_watch', host: 'register.example.org' },
    { source: 'live_sequence', kind: 'registration_watch', opensAt: null },
    { source: 'mintable_window', kind: 'registration_watch', opensForFamilyAt: new Date() },
    { source: 'pending', kind: 'activity_followup' },
    { source: 'pending', kind: 'spot_watch' },
  ];
  it('for every kind and every source', () => {
    for (const kind of READ_CLAIM_KINDS) {
      for (const shape of SOURCES) {
        const row = { familyId: 'eval', what: 'Row', ...shape };
        const candidates = buildClaimCandidates('eval', [row], 'America/Denver');
        const [alias] = candidates.byAlias.keys();
        const verdict = verifyClaimRead(
          {
            status: 'read',
            segments: [{ index: 0, text: 'Plain words.', start: 0, end: 12 }],
            claims: [{ segment: 0, kind, row: alias }],
            usage: { input: 0, output: 0 },
            latencyMs: 0,
            attempts: 1,
          },
          { candidates, locale: 'en', timeZone: 'America/Denver' },
        );
        const verifierBacks = verdict.resolutions[0].status !== 'refused';
        const jsBacks = compatibleRefs({ candidates: [{ ref: 'x', ...shape }] }, kind).length === 1;
        expect(jsBacks, `${kind} × ${shape.source}/${shape.kind}`).toBe(verifierBacks);
      }
    }
  });
});

describe('leakage and privacy', () => {
  const skillText = readFileSync(SKILL, 'utf8');

  it('no fixture body appears in the skill', () => {
    expect(fixtureLeaks(skillText, CLAIM_READ_FIXTURES)).toEqual([]);
  });

  it('the leak check flags a planted body (positive control)', () => {
    const planted = `${skillText}\n${CLAIM_READ_FIXTURES[5].body}\n`;
    expect(fixtureLeaks(planted, CLAIM_READ_FIXTURES)).toEqual([CLAIM_READ_FIXTURES[5].id]);
  });

  it('no fixture string carries a long number, a UUID, an address or a Toronto zone', () => {
    const strings = CLAIM_READ_FIXTURES.flatMap((f) => [
      f.id,
      f.body,
      f.timeZone,
      ...(f.inbound ? [f.inbound] : []),
      ...f.candidates.flatMap((c) => [c.what, ...(c.host ? [c.host] : [])]),
    ]);
    expect(privacyViolations(strings)).toEqual([]);
  });

  it('the privacy check flags each planted violation (positive control)', () => {
    const planted = [
      'ref 1234567',
      '00000000-0000-0000-0000-000000000000',
      'a@example.org',
      'America/Toronto',
    ];
    expect(privacyViolations(planted)).toEqual(planted);
    expect(privacyViolations(['Swim at 10:00 on 2026-11-07'])).toEqual([]);
  });
});

describe('claim-read fixtures: provenance and size (review items 6 and 2)', () => {
  it('every fixture is invented', () => {
    expect(CLAIM_READ_FIXTURES.length).toBeGreaterThan(100);
    expect(CLAIM_READ_FIXTURES.every((f) => f.provenance === 'invented')).toBe(true);
    expect(provenanceViolations(CLAIM_READ_FIXTURES)).toEqual([]);
  });

  it('the provenance check flags a planted fixture with none (positive control)', () => {
    const { provenance: _drop, ...bare } = CLAIM_READ_FIXTURES[0];
    expect(provenanceViolations([bare])).toEqual([bare.id]);
  });

  it('every fixture is inside every bound the production request applies', () => {
    expect(BOUNDS).toEqual({ body: 8_000, inbound: 2_000, what: 160, host: 253 });
    expect(boundViolations(CLAIM_READ_FIXTURES, BOUNDS)).toEqual([]);
  });

  it('the bound check flags a planted 161-code-point label (positive control)', () => {
    const f = CLAIM_READ_FIXTURES[0];
    const planted = {
      ...f,
      candidates: [{ ref: 'x', source: 'pending', kind: 'spot_watch', what: 'é'.repeat(161) }],
    };
    expect(boundViolations([planted], BOUNDS)).toEqual([`${f.id}: what`]);
  });
});
