import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchPhrase } from '../affirmative';
import { withOptOut } from '../opt-out';
import { smsSegments } from '../sms-segments';
import {
  ASIDE_MAX_CHARS,
  type Aside,
  type AsideContext,
  type AsidePlace,
  MAX_ALERT_SEGMENTS,
  assembleWithAside,
  asideViolations,
} from './guard';

/**
 * Every case below is written from the RULE, not from what the code returns, and asserts
 * the WHOLE refusal list rather than "contains" — an over-broad door rule has to show up
 * as an extra entry somewhere, or the door table is measuring nothing.
 *
 * The cores are the shapes `renderEmailAlert` / `renderCalendarAlert` actually produce.
 * They are literals here so this file stays pure; `fixtures-parity.test.ts` is what pins
 * them byte-for-byte against the real renderers.
 */

/** A cancellation with no offer: the commonest email-alert shape, and the shortest. */
const SHORT_CORE = 'Riverside Pool cancelled Sunday swim class - it was Sunday, Sep 20 at 9:00 a.m.';

/** The same, with the lane's own appended ask. */
const OFFER_CTA = 'Reply YES and it goes on your week.';
const CORE_WITH_CTA = `${SHORT_CORE} ${OFFER_CTA}`;

/** A booking receipt: the core ends in a question with NO `ctaSuffix` to read it off,
 * which is the shape `after_an_ask` has to derive rather than be told. */
const CORE_ENDING_IN_A_QUESTION =
  'Riverside Pool says you are in for a spot - first one Sunday, Sep 27 at 9:00 a.m. Want it on your calendar?';

/**
 * A core LONGER than either lane renders today — measured against the real renderers,
 * the longest the corpus produces is 195 characters, which leaves room for a full
 * 60-character clause inside two segments.
 *
 * So the segment rule is a RAIL rather than the common refusal the brief expected it to
 * be, and it is written against a synthetic core because there is no real one that trips
 * it. It still has to exist and still has to be measured on the WIRE: the clamps that buy
 * that headroom are the lanes', they have moved before, and the day one of them widens is
 * the day this rule is the only thing between an aside and a third billed segment. */
const LONG_CORE =
  'Northern Lights Montessori Academy North moved Tuesday afternoon junior tumbling and movement class at the Bayview Gymnasium annex on Sheppard to Tuesday, Sep 23 at 4:30 p.m. - it was Tuesday, Sep 16 at 4:30 p.m. Reply YES and it goes on your week.';

const FORTY_CHAR_CLAUSE = 'Quiet stretch before that one, it seems.';
const SIXTY_ONE_CHAR_CLAUSE = 'A quieter stretch than usual before that one, and calmer now.';

function context(over: Partial<AsideContext> = {}): AsideContext {
  return {
    core: SHORT_CORE,
    lane: 'email_alert',
    priorAlertsToHousehold24h: null,
    matchedAKnownOccasion: false,
    ctaSuffix: null,
    ...over,
  };
}

/** Sorted, so the assertions state WHICH refusals rather than the order they are pushed
 * in — the order is an implementation detail, the set is the contract. */
function refusals(clause: string, place: AsidePlace, ctx: AsideContext): string[] {
  return [...asideViolations({ clause, place }, ctx)].sort();
}

describe('asideViolations - the rule table', () => {
  it('passes a true, third-person clause on a short core', () => {
    expect(refusals('Third one in the last day.', 'before', context())).toEqual([]);
  });

  it('refuses a digit, because the clause is handed no facts at all', () => {
    expect(refusals('3rd one in the last day.', 'before', context())).toEqual(['carries_digit']);
  });

  it('refuses a link, because no tool here could have supplied one', () => {
    expect(refusals('More at www.example.com.', 'before', context())).toEqual(['carries_link']);
  });

  it('refuses a name the core does not carry', () => {
    expect(refusals("Mia's got this one already.", 'before', context())).toEqual([
      'invented_capital',
    ]);
  });

  it('refuses a weekday the core does not carry - a weekday is a fact', () => {
    expect(refusals('Busy Saturday over there.', 'before', context())).toEqual([
      'invented_capital',
    ]);
  });

  it('allows a capitalised token that IS in the core (the positive control)', () => {
    expect(refusals('Short notice from Riverside Pool.', 'before', context())).toEqual([]);
  });

  it('refuses an accented capital, which /^[A-Z]/ would wave through', () => {
    expect(refusals("Looks like Émile's turn next.", 'before', context())).toEqual([
      'invented_capital',
    ]);
  });

  it('does not inherit the CTA own capitals into the allowed set', () => {
    // `YES` is Hale's boilerplate, not a fact the vendor supplied, so a clause that
    // reuses it is inventing a capital even though the wire body contains one.
    const withCta = context({ core: CORE_WITH_CTA, ctaSuffix: OFFER_CTA });
    expect(refusals('Just say YES and I will sort it.', 'before', withCta)).toContain(
      'invented_capital',
    );
  });

  it('refuses a question mark, and an unterminated clause with it', () => {
    expect(refusals('Want me to move it?', 'before', context())).toEqual([
      'asks_a_question',
      'no_terminator',
      'solicits_reply',
    ]);
  });

  it('refuses a clause over the character ceiling', () => {
    expect(SIXTY_ONE_CHAR_CLAUSE.length).toBe(ASIDE_MAX_CHARS + 1);
    expect(refusals(SIXTY_ONE_CHAR_CLAUSE, 'before', context())).toEqual(['over_char_cap']);
  });

  it('refuses a curly apostrophe, and passes the straight one', () => {
    expect(refusals('Quiet week, that’s three now.', 'before', context())).toEqual([
      'not_gsm7_printable',
    ]);
    expect(refusals("Quiet week, that's three now.", 'before', context())).toEqual([]);
  });

  it('refuses a newline, which would open a second line under Hale name', () => {
    expect(refusals('Third one in\nthe last day.', 'before', context())).toEqual([
      'not_gsm7_printable',
    ]);
  });

  it('refuses a clause with no terminator, which would run into the core', () => {
    expect(refusals('Third one in the last day', 'before', context())).toEqual(['no_terminator']);
  });

  it('refuses words placed AFTER the lane own ask, and allows the same clause before it', () => {
    const withCta = context({ core: CORE_WITH_CTA, ctaSuffix: OFFER_CTA });
    expect(refusals('Third one in the last day.', 'after', withCta)).toEqual(['after_an_ask']);
    expect(refusals('Third one in the last day.', 'before', withCta)).toEqual([]);
  });

  it('derives after_an_ask from a question-terminated core, not from a per-lane literal', () => {
    const question = context({ core: CORE_ENDING_IN_A_QUESTION, ctaSuffix: null });
    expect(refusals('Third one in the last day.', 'after', question)).toEqual(['after_an_ask']);
  });

  it('refuses a restatement of the core, punctuation aside', () => {
    expect(refusals('Swim class it was Sunday.', 'before', context())).toEqual(['echoes_the_core']);
  });

  it('refuses a clause that buys a third segment, and allows it where there is headroom', () => {
    expect(FORTY_CHAR_CLAUSE.length).toBe(40);
    const longest = context({ core: LONG_CORE, ctaSuffix: OFFER_CTA });
    expect(refusals(FORTY_CHAR_CLAUSE, 'before', longest)).toEqual(['too_many_segments']);
    // The positive control. An absence test with no positive control fails open: without
    // this line the segment rule could refuse everything and still look right above.
    expect(refusals(FORTY_CHAR_CLAUSE, 'before', context())).toEqual([]);
  });

  it('returns every refusal, never the first', () => {
    expect(refusals('3 things, want me to sort it?', 'before', context())).toEqual([
      'asks_a_question',
      'carries_digit',
      'no_terminator',
      'solicits_reply',
    ]);
  });

  it('treats an empty clause as nothing to add rather than as a refusal', () => {
    expect(refusals('', 'before', context())).toEqual([]);
  });
});

/**
 * THE DOOR — its own block, because it is the rule the spec's shape reintroduces and the
 * only failure here with a consequence beyond a bad sentence. Every clause below passes a
 * guard that checks only for a question mark: no digit, no link, no `?`, one
 * sentence-initial capital, and a full stop at the end.
 */
describe('asideViolations - the door', () => {
  const withCta = () => context({ core: CORE_WITH_CTA, ctaSuffix: OFFER_CTA });

  it('refuses the exemplar door on BOTH halves, not merely one of them', () => {
    // Asserted as both rather than "at least one": the two halves overlap on purpose, and
    // deleting either must leave a failing test behind.
    expect(refusals('Say the word and it goes on your week.', 'before', context())).toEqual([
      'addresses_the_parent',
      'solicits_reply',
    ]);
  });

  it('refuses an explicit YES offer without relying on the capital rule', () => {
    const found = refusals('Just say YES and I will sort it.', 'before', withCta());
    expect(found).toEqual(['echoes_a_reply_word', 'invented_capital', 'solicits_reply']);
    // The point of the row: the DOOR rules carry this, and would carry it even on a core
    // that legitimately contained the token.
    expect(found.filter((refusal) => refusal !== 'invented_capital')).toEqual([
      'echoes_a_reply_word',
      'solicits_reply',
    ]);
  });

  it('refuses an offer framed as a favour', () => {
    expect(refusals('Tell me if you want it moved.', 'before', context())).toEqual([
      'addresses_the_parent',
      'solicits_reply',
    ]);
  });

  it('refuses a bare negative - the case only the affirmative table catches', () => {
    expect(refusals('A no is fine too.', 'before', context())).toEqual(['echoes_a_reply_word']);
  });

  it('refuses a whole-string affirmative', () => {
    expect(refusals('Sounds good either way.', 'before', context())).toEqual([
      'echoes_a_reply_word',
    ]);
  });

  it('refuses the French half, which comes free from the shared table', () => {
    expect(refusals('Oui, encore une.', 'before', context())).toEqual(['echoes_a_reply_word']);
  });

  it('refuses the acts a parent answers with instead of writing', () => {
    // An adversarial pass over the shipped table found four doors it let through, and
    // three of them differ from the exemplar only in which verb of speaking they use.
    // "Holler", "shout", "buzz", "ping" and "nod" are acts, not household nouns, so they
    // belong in the decline table on the same terms as `say` and `tell`.
    for (const clause of [
      'Just holler and it moves.',
      'Nod and it goes on the week.',
      'A shout is enough there.',
      'One buzz and it shifts.',
      'Somebody pinged about that one.',
    ]) {
      expect(refusals(clause, 'before', context())).toContain('solicits_reply');
    }
  });

  it('leaves the two residual doors to the judge, and says so', () => {
    // NAMED RATHER THAN CAUGHT. These read as offers but contain no act of speaking, no
    // second person and no affirmative window, so no mechanical rule reaches them without
    // reaching ordinary observations too. The eval's judge rubric carries them; the guard
    // must not grow a phrase list trying to.
    for (const clause of ['Easy to slot in if needed.', 'Fine to leave it, or not.']) {
      expect(refusals(clause, 'before', context())).toEqual([]);
    }
  });

  it('lets an ordinal observation through (the positive control)', () => {
    expect(refusals('Third one in the last day.', 'before', context())).toEqual([]);
  });

  it('lets a plain third-person observation through (the second positive control)', () => {
    expect(refusals('Short notice, that one.', 'before', context())).toEqual([]);
  });

  it('still answers for a YES in each language the router reads', () => {
    // Anti-drift: a future narrowing of affirmative.ts would quietly widen this door, and
    // this is where that shows up.
    expect(matchPhrase('yes')).not.toBe('unclear');
    expect(matchPhrase('oui')).not.toBe('unclear');
    expect(matchPhrase('好')).not.toBe('unclear');
  });
});

describe('assembleWithAside', () => {
  const clause = 'Third one in the last day.';

  it('returns the core untouched when there is no aside', () => {
    expect(assembleWithAside(SHORT_CORE, null)).toBe(SHORT_CORE);
  });

  it('carries the whole core, byte for byte, in both placements', () => {
    for (const place of ['before', 'after'] as const) {
      const aside: Aside = { clause, place };
      const assembled = assembleWithAside(CORE_WITH_CTA, aside);
      expect(assembled).toContain(CORE_WITH_CTA);
      expect(assembled).toContain(clause);
    }
    expect(assembleWithAside(SHORT_CORE, { clause, place: 'before' })).toBe(
      `${clause} ${SHORT_CORE}`,
    );
    expect(assembleWithAside(SHORT_CORE, { clause, place: 'after' })).toBe(
      `${SHORT_CORE} ${clause}`,
    );
  });

  it('is unrepresentable as a rewrite - the mutation the architecture rests on', () => {
    // The spec asked for a rewrite verified by extraction/diff. This is that rewrite, and
    // the scenario the spec itself names: the model drops the time. The whole-core
    // assertion above goes RED against it and cannot be made green by a tolerance.
    const rewriteAssembler = (_core: string, modelText: string): string => modelText;
    const rewritten = rewriteAssembler(
      SHORT_CORE,
      'Riverside Pool cancelled Sunday swim class - third one in the last day.',
    );
    expect(rewritten).not.toContain(SHORT_CORE);
    expect(assembleWithAside(SHORT_CORE, { clause, place: 'after' })).toContain(SHORT_CORE);
  });
});

describe('the segment rule measures the wire, not the body', () => {
  it('refuses a clause the body alone would have room for', () => {
    // The mutation: measuring `smsSegments(assembled)` without `withOptOut` passes this
    // case, because the CASL line is exactly the 24 septets that tip it over.
    const aside: Aside = { clause: FORTY_CHAR_CLAUSE, place: 'before' };
    const assembled = assembleWithAside(LONG_CORE, aside);
    expect(smsSegments(assembled)).toBeLessThanOrEqual(MAX_ALERT_SEGMENTS);
    expect(smsSegments(withOptOut(assembled, 'full'))).toBeGreaterThan(MAX_ALERT_SEGMENTS);
    expect(refusals(FORTY_CHAR_CLAUSE, 'before', context({ core: LONG_CORE }))).toContain(
      'too_many_segments',
    );
  });

  it('leaves the longest core sendable as it stands today', () => {
    expect(smsSegments(withOptOut(LONG_CORE, 'full'))).toBe(MAX_ALERT_SEGMENTS);
  });
});

describe('guard.ts stays importable outside the web app', () => {
  it('reaches for no ~/ alias', () => {
    // NOT tidiness. `run-alert-aside-eval.mjs` tsImports this file REAL rather than
    // replicating it, and the tsx loader there cannot resolve the web app's `~/` alias —
    // which is why the follow-up suite replicates its composer's gates and accepts that
    // the replica can drift from the shipped one. Here there is nothing to drift.
    const source = readFileSync(new URL('./guard.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/['"]~\//);
  });
});
