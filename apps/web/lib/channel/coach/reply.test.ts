import { describe, expect, it, vi } from 'vitest';
import { SAFETY_REPLY } from '~/lib/channel/off-domain/copy';
import { smsSegments } from '~/lib/channel/sms-segments';
import { MAX_REPLY_SEGMENTS, redactTeenNames, toSmsReply } from './reply';

/**
 * The post-processing between the model and the carrier. Everything asserted here is a
 * BACKSTOP: the skill already asks for plain, short, ASCII prose. These tests pin what
 * happens when it doesn't get one — which is the only case that matters, because the
 * model is the one part of this path that cannot be made to behave by construction.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';

/** DOBs derived from the @hale/types stage boundary (teenager ≥ 156 months), against
 * NOW rather than from any code output. */
const TEEN = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };
const TODDLER = { name: 'Milo', gender: 'boy', dateOfBirth: '2024-07-30' };

describe('redactTeenNames', () => {
  it("replaces a 13+ child's first name with the generic identifier", () => {
    const out = redactTeenNames("Nora's shift moved to Thursday.", [TEEN], NOW);

    expect(out).toBe("your kid's shift moved to Thursday.");
  });

  it('leaves a under-13 child named', () => {
    const out = redactTeenNames('Milo has swim on Tuesday.', [TODDLER], NOW);

    expect(out).toBe('Milo has swim on Tuesday.');
  });

  it('matches the name case-insensitively and only on word boundaries', () => {
    const out = redactTeenNames('nora is out. Noraville is a place.', [TEEN], NOW);

    expect(out).toBe('your kid is out. Noraville is a place.');
  });

  it('ages the gate live — a child 13 next month is still named today', () => {
    const almost = { name: 'Kit', gender: 'boy', dateOfBirth: '2013-08-30' };

    expect(redactTeenNames('Kit has practice.', [almost], NOW)).toBe('Kit has practice.');
  });

  it('redacts a name whose first or last letter is accented', () => {
    const chloe = { name: 'Chloé', gender: 'girl', dateOfBirth: '2010-03-04' };
    const emile = { name: 'Émile', gender: 'boy', dateOfBirth: '2010-03-04' };

    expect(redactTeenNames('Chloé has practice Thursday.', [chloe], NOW)).toBe(
      'your kid has practice Thursday.',
    );
    expect(redactTeenNames('Practice is with Chloé.', [chloe], NOW)).toBe(
      'Practice is with your kid.',
    );
    expect(redactTeenNames('Émile is out.', [emile], NOW)).toBe('your kid is out.');
  });

  it('still stops at the whole name when the boundary is an accented letter', () => {
    const lea = { name: 'Léa', gender: 'girl', dateOfBirth: '2010-03-04' };
    const leana = { name: 'Léana', gender: 'girl', dateOfBirth: '2021-03-04' };

    expect(redactTeenNames('Léana is with Léa on Thursday.', [lea, leana], NOW)).toBe(
      'Léana is with your kid on Thursday.',
    );
  });
});

describe('toSmsReply', () => {
  it('strips markdown the phone would render literally', () => {
    const raw = '**Two swims** this week:\n\n- Mon 4:30\n- Thu 5:15\n\nWhich one?';

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe('Two swims this week: Mon 4:30 Thu 5:15 Which one?');
  });

  it('transliterates the characters that would flip the message to UCS-2', () => {
    const raw = 'Move swim to Tue 4:30 — it’s free then. YES to confirm.';

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(out).toBe("Move swim to Tue 4:30 - it's free then. YES to confirm.");
    expect(smsSegments(out)).toBe(1);
  });

  it('redacts a teen name before the body ever reaches the carrier', () => {
    const out = toSmsReply('Nora has practice Thursday.', {
      children: [TEEN],
      now: NOW,
    });

    expect(out).toBe('your kid has practice Thursday.');
  });

  it('leaves a reply already inside the budget untouched', () => {
    const raw = 'Move swim to Tue 4:30? YES to confirm.';

    expect(toSmsReply(raw, { children: [], now: NOW })).toBe(raw);
  });

  /**
   * The trim drops whole sentences from the END and stops there. It used to append
   * "More in the app: <url>", which fired precisely when the answer was too long to
   * send — the app-point on the message that mattered most (skill audit P0 #4). What
   * survives is the FIRST sentence, which is where the skill puts the answer, and what
   * the trim must never do is exceed the budget it exists to enforce.
   */
  it('trims an over-budget reply to whole sentences, and points nowhere', () => {
    const raw = [
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week.',
      'The Thursday one is at the east pool rather than the usual west pool.',
      'There is also a make-up class on Saturday morning if you would rather do that.',
      'Registration for the fall session opens on the fifteenth of next month.',
      'I can draft any of those changes for you to approve whenever you are ready.',
    ].join(' ');

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(smsSegments(raw)).toBeGreaterThan(MAX_REPLY_SEGMENTS);
    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).not.toContain(LINK);
    expect(out).not.toMatch(/\bthe app\b/i);
    expect(out.startsWith('Swim is on Tuesday')).toBe(true);
    // Whole sentences only — the trim never lands mid-word.
    expect(out).not.toMatch(/\w\.\.\.\s/);
  });

  /**
   * "1-2:30 p.m." is not the end of a sentence, and treating it as one is how a trim
   * lands INSIDE a fact.
   *
   * Live probe, 2026-08-21: the coach composed "Kids & Me drop-in runs free Thursdays
   * 1-2:30 p.m. at Acton Library - both from their own sites, not yet confirmed" and the
   * parent received it cut at the "p.m." — a find stripped of its venue and of the source
   * attribution the skill requires of every web find, which reads as a fact Hale stands
   * behind rather than one somebody's site claims. The trim's whole promise is that it
   * drops WHOLE sentences, and an abbreviation it mistakes for a full stop makes that
   * promise false.
   *
   * So the find below does not fit, and the right outcome is that it does not go: a
   * drop-in with no address is not a shorter answer, it is an unusable one.
   */
  it('drops a find whole rather than cutting it at an abbreviated time', () => {
    const schedule =
      'Swim is on Tuesday at four thirty and Thursday at five fifteen this week, and the ' +
      'Thursday one is at the east pool rather than the usual west pool, so give yourself ' +
      'a few extra minutes to get across town before the lesson starts.';
    const find =
      'Kids and Me drop-in runs free Thursdays 1-2:30 p.m. at Acton Library - their site ' +
      'says so.';

    const out = toSmsReply(`${schedule} ${find}`, { children: [], now: NOW });

    expect(smsSegments(`${schedule} ${find}`)).toBeGreaterThan(MAX_REPLY_SEGMENTS);
    expect(out).toBe(schedule);
    // The specific mutilation: the time without the place it is at.
    expect(out).not.toContain('1-2:30 p.m.');
  });

  it('trims a single unbroken over-budget sentence on a word boundary', () => {
    const raw = `${'swim '.repeat(80)}now`;

    const out = toSmsReply(raw, { children: [], now: NOW });

    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(out).not.toContain(LINK);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toMatch(/swi\b/);
  });

  /** No prefix of a single 300-character token fits, so there is nothing honest left to
   * send. The router reads the throw as a failed turn and answers with its own template
   * — the same outcome an empty body gets, and the right one. */
  it('refuses a body with no prefix inside the budget', () => {
    expect(() => toSmsReply('x'.repeat(400), { children: [], now: NOW })).toThrow(/budget/i);
  });

  it('refuses to emit an empty body', () => {
    expect(() => toSmsReply('   \n  ', { children: [], now: NOW })).toThrow(/empty/i);
  });
});

/**
 * WHAT A TRIM COSTS, on the turn Hale is built around — the 2026-08-21 answer-quality
 * bench, seq 5. A Halton Hills family asked what was on for their toddler Sept-Dec; the
 * turn spent ~50s on a live web search, came back holding a hand-verified Sep 1 opening
 * AND two grounded finds, and composed 548 units against a 306-unit budget.
 *
 * Both tests below run the SAME two facts through the SAME function. The only difference
 * is how they were composed, which is the whole finding: the trim is not what is broken.
 * It drops from the end, whole sentences, exactly as designed — and no policy it could
 * adopt would fit 548 units into 306 without cutting a price or a date in half and
 * putting a fact on the wire that is not true. What has to change is the writing, so the
 * skill now states the ceiling in the unit this function enforces (skill-parity.test.ts)
 * and asks for the date as one clause rather than a paragraph of its own.
 *
 * What this function owes in the meantime is to stop doing it in silence: nothing
 * downstream could tell an answer that fit from one amputated to fit, which is why the
 * defect had to be found by a human reading a graded bench run.
 */
describe('an over-budget composition', () => {
  /** Verbatim from bench-calls-adv-verify.json seq 5. Do not reflow: its length IS the
   * fixture. */
  const BENCH_SEQ5 =
    'Two things worth flagging here. Fall 2026 recreation registration opens Sep 1 at ' +
    "7:00 a.m. for Halton Hills residents (Sep 8 for everyone else) - I'm already " +
    "watching it and I'll text you the week before and again just before it opens." +
    '\n\nIn the meantime, the Town of Halton Hills lists Toddler Dance for ages 2-6, ' +
    "though their site doesn't have fall dates or pricing up yet. The Acton EarlyON on " +
    'Wallace St is free for under-sixes with drop-in play most weekday mornings - their ' +
    'site says to check the Links2Care seasonal schedule for current times.';

  /** The same turn's facts, composed to the ceiling the skill now states: the verified
   * date as ONE CLAUSE, then the find. Nothing is dropped because nothing has to be. */
  const COMPOSED_TO_BUDGET =
    "Halton Hills fall registration opens Sep 1, 7:00 a.m. for residents and I'm on it - " +
    'meanwhile the Acton EarlyON on Wallace St is free drop-in for under-sixes, their ' +
    'site says to check the seasonal schedule.';

  it('says out loud that it dropped a paragraph, so the loss is countable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = toSmsReply(BENCH_SEQ5, { children: [], now: NOW });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`past the ${MAX_REPLY_SEGMENTS}-segment budget`),
    );
    // The body itself never reaches the log — it can carry back what the parent typed
    // (rule #1). Only how far over the line it ran.
    expect(warn.mock.calls[0]?.[0]).not.toContain('Halton Hills');
    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    // The cost, asserted rather than described: the registration lead survives and BOTH
    // web finds are gone, on a message that opened by promising two things.
    expect(out).toContain('Sep 1');
    expect(out).not.toContain('EarlyON');
    expect(out).not.toContain('Toddler Dance');

    warn.mockRestore();
  });

  it('carries the same two facts whole when they were written to fit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const out = toSmsReply(COMPOSED_TO_BUDGET, { children: [], now: NOW });

    // The positive control for the two absences above: the same path, the same budget,
    // the find intact. Without it "does not contain EarlyON" would also pass on a
    // function that dropped everything.
    expect(out).toBe(COMPOSED_TO_BUDGET);
    expect(out).toContain('Sep 1');
    expect(out).toContain('Acton EarlyON');
    expect(smsSegments(out)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});

/**
 * Skill audit P0 #3 — the siren, on the path that fires when the screen breaks.
 *
 * The off-domain screen FAILS OPEN by design (screen.ts openTheGate), so on a missing
 * key, a skill-load failure or a provider outage a "she hit her head and won't stop
 * crying" walks straight past the fixed 811/911 line and into the coach, whose skill
 * then asks it for a siren of its own — one that historically named a doctor and no
 * number at all. A prompt cannot be the guarantee here. This is.
 *
 * Strict equality against the constant, never a regex: "mentions 811" is what the
 * improvised version already did. What a parent standing over a hurt child gets has to
 * be the reviewed sentence, whole, including the 911 the improvisation drops.
 */
describe('the fixed safety reply is the only siren that leaves the coach', () => {
  const send = (raw: string) => toSmsReply(raw, { children: [], now: NOW });

  it.each([
    ['a referral naming only the health line', 'Sounds rough - call 811 if it gets worse.'],
    ['a referral naming only emergency', 'If she is struggling to breathe, call 911 now.'],
    ['a referral wrapped in advice', 'Most bumps are fine. Watch her, and 811 can advise.'],
    ['a referral buried in a scheduling answer', 'Swim is Tuesday. Ring 811 about the rash.'],
  ])('replaces %s with the fixed line, verbatim', (_name, raw) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send(raw)).toBe(SAFETY_REPLY);
  });

  it('is idempotent — the fixed line survives its own guard unchanged', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(send(SAFETY_REPLY)).toBe(SAFETY_REPLY);
  });

  it('says out loud that it fired, so an improvised siren is countable', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    send('Call 811 about that one.');

    expect(logged).toHaveBeenCalledTimes(1);
  });

  /** The trigger is the two numbers as whole tokens, so an ordinary week does not trip
   * it: a clock time and a phone number both carry those digits inside something else. */
  it.each([
    'Swim moved to Thursday at 9:11 and I have told the coach.',
    'The number they gave me is 647-555-0811, want me to save it?',
  ])('leaves an ordinary reply alone: %s', (raw) => {
    expect(send(raw)).toBe(raw);
  });
});

describe('the plan offer line', () => {
  const child = { name: 'Milo', gender: 'boy', dateOfBirth: '2021-05-01' };
  // Composed by the model and already gated by offer_full_plan — the runtime only
  // protects it from the trim; it does not author it.
  const OFFER_LINE = "Want the full plan? Reply YES and I'll send it.";

  it('is appended by code, so the model never has to spend budget on it', () => {
    const reply = toSmsReply('Try a gradual fade over two weeks.', {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply).toBe(
      "Try a gradual fade over two weeks. Want the full plan? Reply YES and I'll send it.",
    );
  });

  it('trims the ANSWER to make room, never the offer', () => {
    // The bug this exists to prevent: a coaching answer plus the offer runs past two
    // segments, the trim takes from the end, and the parent gets "Want the full plan?"
    // with the half that says the magic word cut off — an offer they cannot accept.
    const long = `${'A gradual fade works well here. '.repeat(9)}One last background clause.`;

    const reply = toSmsReply(long, {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply.endsWith("Want the full plan? Reply YES and I'll send it.")).toBe(true);
    expect(smsSegments(reply)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
  });

  it('does not append when the turn offered nothing', () => {
    const reply = toSmsReply('Cancel Thursday swim? YES to confirm.', {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
    });

    expect(reply).toBe('Cancel Thursday swim? YES to confirm.');
  });

  it('sends the offer once when the model wrote it too', () => {
    const reply = toSmsReply(
      "Try a gradual fade over two weeks. Want the full plan? Reply YES and I'll send it.",
      { children: [child], now: new Date('2026-08-12T12:00:00.000Z'), planOffer: OFFER_LINE },
    );

    expect(reply.match(/Want the full plan\?/g)).toHaveLength(1);
  });

  it('sends the offer alone, unpadded, when the whole answer WAS the offer', () => {
    const reply = toSmsReply(OFFER_LINE, {
      children: [child],
      now: new Date('2026-08-12T12:00:00.000Z'),
      planOffer: OFFER_LINE,
    });

    expect(reply).toBe(OFFER_LINE);
  });
});

describe('the referral block', () => {
  const child = { name: 'Milo', gender: 'boy', dateOfBirth: '2021-05-01' };
  const teen = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };
  const now = new Date('2026-08-12T12:00:00.000Z');
  // What share_referral_link registered: the model's forwardable line, then the link the
  // RUNTIME assembled. The model never composed the URL.
  const BLOCK =
    "It's a text line that keeps the family week straight. https://www.villagehale.com/text?s=friend-0123456789ab";

  it('is appended after the answer, with the link last', () => {
    const reply = toSmsReply('Forward this to them - when they text me, that is their yes.', {
      children: [child],
      now,
      referral: BLOCK,
    });

    expect(reply).toBe(
      `Forward this to them - when they text me, that is their yes. ${BLOCK}`,
    );
  });

  it('trims the ANSWER, never the link — a truncated URL is a broken referral', () => {
    // Sharper than the offer case: the trim takes from the END, and the last thing in
    // this block is the only part of the message that does any work.
    const long = `${'Happy to pass this along whenever you like. '.repeat(8)}One trailing clause.`;

    const reply = toSmsReply(long, { children: [child], now, referral: BLOCK });

    expect(reply.endsWith('https://www.villagehale.com/text?s=friend-0123456789ab')).toBe(true);
    expect(smsSegments(reply)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
  });

  it('redacts a teen name inside the forwarded line (rule #1 — a parent sends this OUT)', () => {
    // The one piece of outbound text that leaves the family. The teen floor is
    // age-derived, so it has to cover the suffix and not just the answer.
    const reply = toSmsReply('Forward this to them.', {
      children: [teen],
      now,
      referral: "Nora's family uses it to keep the week straight. https://www.villagehale.com/text?s=friend-0123456789ab",
    });

    expect(reply).not.toContain('Nora');
    expect(reply).toContain('https://www.villagehale.com/text?s=friend-0123456789ab');
  });

  it('does not append when the turn shared nothing', () => {
    expect(toSmsReply('Cancel Thursday swim? YES to confirm.', { children: [child], now })).toBe(
      'Cancel Thursday swim? YES to confirm.',
    );
  });
});
