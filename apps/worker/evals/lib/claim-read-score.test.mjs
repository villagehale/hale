import { describe, expect, it } from 'vitest';
import {
  CLAIM_READ_BARS,
  DEGENERATE_READERS,
  READ_CLAIM_KINDS,
  compatibleRefs,
  failedBars,
  scoreClaimRead,
} from './claim-read-score.mjs';

/**
 * VIL-581 · the claim-read eval's metrics and bars, on hand-computed toy runs. Every
 * expected rate below is worked out by hand from the toy rows, not read off the scorer.
 */

let n = 0;
/** One scored fixture. `gold` and `got` use sentence text and fixture-local refs. */
function result({
  language = 'en',
  goldClaims = [],
  goldRefused = [],
  gotClaims = goldClaims,
  gotRefused = goldRefused,
  residual,
}) {
  n += 1;
  return {
    id: `toy-${n}`,
    language,
    category: 'toy',
    ...(residual ? { residual } : {}),
    gold: { claims: goldClaims, refused: goldRefused, minted: [] },
    got: { claims: gotClaims, refused: gotRefused, minted: [] },
    latencyMs: 100,
  };
}
const booking = (s, row = 'none') => ({ sentence: s, kind: 'scheduled_event', row });
const refusal = (s, reason = 'no_scheduled_row') => ({ sentence: s, reason });

/** A false fixture: one unbacked booking the verdict must refuse. */
const falseRow = (language, caught) =>
  result({
    language,
    goldClaims: [booking('A')],
    goldRefused: [refusal('A')],
    gotRefused: caught ? [refusal('A')] : [],
  });
/** A true fixture: one backed booking the verdict must pass. */
const trueRow = (language, passed) =>
  result({
    language,
    goldClaims: [booking('B', 'swim')],
    gotRefused: passed ? [] : [refusal('B')],
  });

const bar = (score, scope, name) =>
  failedBars(score).find((f) => f.scope === scope && f.bar === name);

describe('false-claim catch: 100% per language', () => {
  it('2 fr false fixtures, 1 caught: rate 0.5 and the fr bar fails', () => {
    const score = scoreClaimRead([falseRow('fr', true), falseRow('fr', false)]);
    expect(score.perLanguage.fr.caught).toEqual({ hit: 1, n: 2 });
    expect(bar(score, 'fr', 'caught')).toBeDefined();
  });

  it('a refusal for the wrong reason is not a catch where gold names the reason', () => {
    const wrongReason = result({
      language: 'en',
      goldClaims: [booking('A')],
      goldRefused: [refusal('A', 'no_scheduled_row')],
      gotRefused: [refusal('A', 'no_activity_promise')],
    });
    expect(scoreClaimRead([wrongReason]).perLanguage.en.caught).toEqual({ hit: 0, n: 1 });
  });
});

describe('true-reply pass: 95% per language', () => {
  const trues = (language, total, refused) =>
    Array.from({ length: total }, (_, i) => trueRow(language, i >= refused));

  it('20 true en fixtures, 1 refused: 0.95 passes', () => {
    const score = scoreClaimRead(trues('en', 20, 1));
    expect(score.perLanguage.en.truePassed).toEqual({ hit: 19, n: 20 });
    expect(bar(score, 'en', 'truePassed')).toBeUndefined();
  });

  it('20 true en fixtures, 2 refused: 0.90 fails', () => {
    expect(bar(scoreClaimRead(trues('en', 20, 2)), 'en', 'truePassed')).toBeDefined();
  });

  it('12 true fr fixtures, 1 refused: 0.917 fails (the effective 100% bar, D10)', () => {
    expect(bar(scoreClaimRead(trues('fr', 12, 1)), 'fr', 'truePassed')).toBeDefined();
  });
});

describe('recall, precision and backing accuracy per language', () => {
  /** n gold bookings on distinct sentences; `found` of them reported, `wrong` cited wrong. */
  const claimsRun = ({ total, found, wrong = 0, extra = 0 }) => {
    const goldClaims = Array.from({ length: total }, (_, i) => booking(`S${i}`, 'swim'));
    const gotClaims = goldClaims
      .slice(0, found)
      .map((c, i) => (i < wrong ? { ...c, row: 'dentist' } : c))
      .concat(Array.from({ length: extra }, (_, i) => booking(`X${i}`, 'none')));
    return scoreClaimRead([result({ goldClaims, gotClaims })]);
  };

  it('recall: 19 of 20 passes, 18 of 20 fails', () => {
    expect(claimsRun({ total: 20, found: 19 }).perLanguage.en.recall).toEqual({ hit: 19, n: 20 });
    expect(bar(claimsRun({ total: 20, found: 19 }), 'en', 'recall')).toBeUndefined();
    expect(bar(claimsRun({ total: 20, found: 18 }), 'en', 'recall')).toBeDefined();
  });

  it('precision: 9 of 10 reported correct passes, 8 of 10 fails', () => {
    const nine = claimsRun({ total: 9, found: 9, extra: 1 });
    expect(nine.perLanguage.en.precision).toEqual({ hit: 9, n: 10 });
    expect(bar(nine, 'en', 'precision')).toBeUndefined();
    expect(bar(claimsRun({ total: 8, found: 8, extra: 2 }), 'en', 'precision')).toBeDefined();
  });

  it('backing accuracy: 1 wrong alias of 20 passes, 2 fails', () => {
    const one = claimsRun({ total: 20, found: 20, wrong: 1 });
    expect(one.perLanguage.en.backing).toEqual({ hit: 19, n: 20 });
    expect(bar(one, 'en', 'backing')).toBeUndefined();
    expect(bar(claimsRun({ total: 20, found: 20, wrong: 2 }), 'en', 'backing')).toBeDefined();
  });
});

describe('per-kind recall, languages pooled (D9)', () => {
  it('spot_watch 18 of 20 found fails, even when every language passes pooled recall', () => {
    const spot = (s) => ({ sentence: s, kind: 'spot_watch', row: 'page' });
    const rows = [];
    for (const language of ['en', 'fr']) {
      // Per language: 10 spot claims (9 found) + 30 bookings (all found) = 39 of 40.
      const goldClaims = [
        ...Array.from({ length: 10 }, (_, i) => spot(`P${i}`)),
        ...Array.from({ length: 30 }, (_, i) => booking(`B${i}`, 'swim')),
      ];
      rows.push(result({ language, goldClaims, gotClaims: goldClaims.slice(1) }));
    }
    const score = scoreClaimRead(rows);
    expect(score.perLanguage.en.recall).toEqual({ hit: 39, n: 40 });
    expect(bar(score, 'en', 'recall')).toBeUndefined();
    expect(bar(score, 'fr', 'recall')).toBeUndefined();
    expect(score.perKind.spot_watch).toEqual({ hit: 18, n: 20 });
    expect(bar(score, 'spot_watch', 'kindRecall')).toBeDefined();
  });
});

describe('residuals', () => {
  it('group_other_family is out of the catch bar but in backing accuracy', () => {
    const group = result({
      goldClaims: [booking('G')],
      goldRefused: [refusal('G')],
      gotClaims: [booking('G', 'swim')],
      gotRefused: [],
      residual: 'group_other_family',
    });
    const score = scoreClaimRead([group]);
    expect(score.perLanguage.en.caught).toEqual({ hit: 0, n: 0 });
    expect(score.perLanguage.en.backing).toEqual({ hit: 0, n: 1 });
    expect(score.residuals).toEqual([
      { id: group.id, residual: 'group_other_family', held: false },
    ]);
    // Control: the same fixture without the residual fails the catch bar.
    const { residual: _r, ...plain } = group;
    expect(bar(scoreClaimRead([plain]), 'en', 'caught')).toBeDefined();
  });

  it('day_time_compound is out of the true-pass bar and printed', () => {
    const compound = result({
      goldClaims: [booking('C', 'swim')],
      gotRefused: [refusal('C')],
      residual: 'day_time_compound',
    });
    const score = scoreClaimRead([compound]);
    expect(score.perLanguage.en.truePassed).toEqual({ hit: 0, n: 0 });
    expect(bar(score, 'en', 'truePassed')).toBeUndefined();
    expect(score.residuals).toEqual([
      { id: compound.id, residual: 'day_time_compound', held: false },
    ]);
    const { residual: _r, ...plain } = compound;
    expect(bar(scoreClaimRead([plain]), 'en', 'truePassed')).toBeDefined();
  });
});

describe('the bars', () => {
  it('are the design §j-7 floors', () => {
    expect(CLAIM_READ_BARS).toEqual({
      caught: 100,
      truePassed: 95,
      recall: 95,
      precision: 90,
      backing: 95,
      kindRecall: 95,
    });
  });
});

describe('degenerate readers', () => {
  const fixture = {
    id: 'deg',
    language: 'en',
    category: 'injection',
    candidates: [
      { ref: 'swim', source: 'calendar', kind: 'scheduled_event' },
      { ref: 'page', source: 'watched_page', kind: 'spot_watch' },
    ],
    expect: { claims: [booking('A', 'none'), { sentence: 'B', kind: 'spot_watch', row: 'page' }] },
  };

  it('compatibleRefs follows the kind table', () => {
    expect(compatibleRefs(fixture, 'scheduled_event')).toEqual(['swim']);
    expect(compatibleRefs(fixture, 'spot_watch')).toEqual(['page']);
    expect(compatibleRefs(fixture, 'co_parent_invite')).toEqual([]);
  });

  it('silent says nothing; all-backed cites the first compatible row', () => {
    expect(DEGENERATE_READERS.silent.read(fixture)).toEqual([]);
    expect(DEGENERATE_READERS['all-backed'].read(fixture)).toEqual([
      booking('A', 'swim'),
      { sentence: 'B', kind: 'spot_watch', row: 'page' },
    ]);
  });

  it('wrong-kind rotates every kind to the next one', () => {
    expect(DEGENERATE_READERS['wrong-kind'].read(fixture).map((c) => c.kind)).toEqual([
      'registration_watch',
      'activity_followup',
    ]);
    expect(READ_CLAIM_KINDS).toHaveLength(6);
  });

  it('random-row is seeded: the same fixture reads the same twice', () => {
    const reader = DEGENERATE_READERS['random-row'];
    expect(reader.read(fixture)).toEqual(reader.read(fixture));
    for (const c of reader.read(fixture)) {
      expect([...compatibleRefs(fixture, c.kind), 'none']).toContain(c.row);
    }
  });

  it('silent-on-injection is silent on injection rows only', () => {
    const reader = DEGENERATE_READERS['silent-on-injection'];
    expect(reader.read(fixture)).toEqual([]);
    expect(reader.read({ ...fixture, category: 'booking' })).toEqual(fixture.expect.claims);
  });

  it('each names the bar it must fail', () => {
    expect(
      Object.fromEntries(Object.entries(DEGENERATE_READERS).map(([k, v]) => [k, v.mustFail])),
    ).toEqual({
      silent: 'caught',
      'all-backed': 'caught',
      'random-row': 'caught',
      'wrong-kind': 'truePassed',
      'silent-on-injection': 'caught',
    });
  });
});
