import { playbookFor } from '@hale/types';
import { describe, expect, it } from 'vitest';
import {
  type PlanGrounding,
  namesTheMethod,
  planViolations,
  retryUserMessage,
  withoutChannelUrl,
} from './compose';

/**
 * The gates, and what they say to the model that has to rewrite the plan.
 *
 * QUALITY is an eval against real cached Claude (rule #8). What is pinned here is the
 * part a prompt cannot guarantee: the shapes that must never reach a phone, the method
 * name that must, and — because these strings are read by a model on the next attempt —
 * that each violation names the thing to FIX rather than the rule it broke.
 *
 * Every assertion is a violation the recompose loop depends on being raised. A gate that
 * silently passes is a gate that ships the thing it exists to stop.
 */

const PLAYBOOK = playbookFor('sleep');
const DAY_NAMES = { 2: 'Thursday', 3: 'Friday', 4: 'Saturday', 5: 'Sunday' } as const;

const GROUNDING: PlanGrounding = {
  topic: 'sleep',
  question: 'he wakes at 3am every night',
  child: { ageMonths: 18, stage: 'toddler' },
  playbook: PLAYBOOK,
  facts: [],
  checkInDayNames: DAY_NAMES,
};

/** A plan that clears every gate: names the method, sequenced, promises Friday. */
const GOOD = [
  'Nights 1-3: put him down drowsy but awake and use the Ferber method - wait 3 minutes before your first check, then 5, then 10.',
  'Nights 4-7: same routine, stretch the waits to 12 and 15. Expect night 2 or 3 to be the worst; that spike is the pattern breaking.',
  "After that most families see it settle. I'll check in Friday to see how the nights are going.",
];

const chars = (n: number) => `${'a'.repeat(n)} Ferber Friday`;

describe('a plan that may be sent', () => {
  it('raises nothing', () => {
    expect(planViolations(GOOD, GROUNDING, 3)).toEqual([]);
  });
});

describe('the shape gates', () => {
  it('refuses a one-message plan — that is the answer they already had', () => {
    expect(planViolations([GOOD[0] as string], GROUNDING, 3)).toContainEqual(
      expect.stringContaining('must be exactly 2 or 3'),
    );
  });

  it('refuses a check-in offset outside the band', () => {
    expect(planViolations(GOOD, GROUNDING, 9)).toContainEqual(
      expect.stringContaining('checkInDays was 9'),
    );
  });

  it('names WHICH stage is over budget, because the model has to fix that one', () => {
    const violations = planViolations([GOOD[0] as string, chars(600)], GROUNDING, 3);

    // Named to the character and phrased as MOVE, because the second reader of this
    // string is the model on the next attempt and "cut it" lost content it should have
    // relocated.
    expect(
      violations.some((v) => v.includes('Message 2') && v.includes('over the') && v.includes('Move a sentence')),
    ).toBe(true);
  });

  /** The gate is a SEGMENT count, and a UCS-2 body blows three segments at 202 units
   * where a GSM-7 one takes 460. A budget quoted in the wrong currency told the model it
   * was "-249 over the limit" — a number that is not true, in the one string the
   * recompose loop has to learn from. */
  it('names a true overage when the overflow comes from the encoding, not the length', () => {
    const emojiBody = `${'a'.repeat(210)} \u{1f389} Ferber Friday`;

    const overBudget = planViolations([GOOD[0] as string, emojiBody], GROUNDING, 3).filter((v) =>
      v.includes('over the'),
    );

    expect(overBudget).toHaveLength(1);
    const overage = Number(/, (-?\d+) over the/.exec(overBudget[0] as string)?.[1]);
    expect(overage).toBeGreaterThan(0);
  });
});

describe('the content gates', () => {
  it('refuses a plan that never names its method', () => {
    const unnamed = GOOD.map((body) => body.replace('the Ferber method', 'a routine'));

    // The founder's requirement, held in code: a plan that will not say "the Ferber
    // method" is a plan a parent cannot look up or tell their partner about.
    expect(planViolations(unnamed, GROUNDING, 3)).toContainEqual(
      expect.stringContaining('Graduated check-ins (Ferber method)'),
    );
  });

  it('refuses a plan that names a dose', () => {
    const dosed = [GOOD[0] as string, 'If he is still fussing, 5ml should settle him. Friday.'];

    expect(planViolations(dosed, GROUNDING, 3).some((v) => v.includes('dose'))).toBe(true);
  });

  it('refuses a plan that reaches for 811 — and says to name the situation instead', () => {
    const siren = [GOOD[0] as string, 'If the waking gets worse, call 811. Friday.'];
    const violations = planViolations(siren, GROUNDING, 3);

    // The siren is a VIOLATION TO REWRITE here, not a body to swap out: this is a
    // how-to question, and a phone number in the middle of a sleep plan is the model
    // losing its nerve. The fix is the plan, not a referral in its place.
    expect(violations.some((v) => v.includes('811') && v.includes('SITUATION'))).toBe(true);
  });

  it('refuses a bare-domain link, which is the one the playbook itself tempts', () => {
    // A vetted creator's credential carries "youtube.com/c/EmmaHubbard". A gate that
    // only knew https:// would wave that straight through.
    const linked = [GOOD[0] as string, 'More at youtube.com/c/TheDoctorsBjorkman. Friday.'];

    expect(planViolations(linked, GROUNDING, 3).some((v) => v.includes('link'))).toBe(true);
  });
});

describe('the citation gates', () => {
  it('refuses a name that is not on the vetted list', () => {
    const invented = [GOOD[0] as string, 'Dr. Marsden has a good walkthrough on this. Friday.'];
    const violations = planViolations(invented, GROUNDING, 3);

    expect(violations.some((v) => v.includes('Marsden') && v.includes('approved list'))).toBe(true);
  });

  it('allows the one vetted name for this topic', () => {
    const cited = [
      GOOD[0] as string,
      "The Doctors Bjorkman - he's a pediatrician - has a good walkthrough. I'll check in Friday.",
    ];

    expect(planViolations(cited, GROUNDING, 3)).toEqual([]);
  });
});

describe('the promised day', () => {
  it('refuses a plan that chose a day and never said it', () => {
    const silent = GOOD.map((body) => body.replace('Friday', 'soon'));
    const violations = planViolations(silent, GROUNDING, 3);

    // The row will come back on that day whether or not the parent was told. The
    // promise IS the feature.
    expect(violations.some((v) => v.includes('promise the day') && v.includes('Friday'))).toBe(
      true,
    );
  });

  it('holds the plan to the day matching its OWN chosen offset', () => {
    // Chose 2 (Thursday) but wrote Friday: the prose and the ledger row would disagree,
    // and the row is the one that fires.
    const violations = planViolations(GOOD, GROUNDING, 2);

    expect(violations.some((v) => v.includes('Thursday'))).toBe(true);
  });
});

describe('namesTheMethod', () => {
  it('accepts the natural phrasing, not just the curated label', () => {
    // The curated name is "Graduated check-ins (Ferber method)". A parent-facing
    // sentence says "the Ferber method", and a gate that demanded the full label would
    // be teaching the skill to write like a database.
    expect(namesTheMethod('use the Ferber method tonight', PLAYBOOK)).toBe(true);
    expect(namesTheMethod('try graduated check-ins', PLAYBOOK)).toBe(true);
    expect(namesTheMethod('just be consistent about it', PLAYBOOK)).toBe(false);
  });
});

describe('withoutChannelUrl', () => {
  it('drops the trailing channel address and keeps the credential', () => {
    const creator = PLAYBOOK.goDeeper[0];
    const projected = withoutChannelUrl(creator?.credential ?? '');

    // Handing a model a URL and then refusing every URL is a trap rather than a rule.
    expect(projected).not.toContain('youtube.com');
    expect(projected.length).toBeGreaterThan(20);
  });

  it('keeps the semicolons inside a credential, which a split would eat', () => {
    const kept = withoutChannelUrl(
      'Paediatric OT (degree, Newcastle, 2008; 12+ years practice); youtube.com/c/Someone',
    );

    expect(kept).toBe('Paediatric OT (degree, Newcastle, 2008; 12+ years practice)');
  });
});

describe('retryUserMessage', () => {
  it('carries the violations back in the same payload, so each attempt caches apart', () => {
    const retried = retryUserMessage(JSON.stringify({ question: 'x' }), ['Message 2 is 4 segments.']);

    expect(JSON.parse(retried)).toEqual({
      question: 'x',
      rejectedLastAttempt: ['Message 2 is 4 segments.'],
    });
  });

  it('leaves a first attempt untouched', () => {
    expect(retryUserMessage('{"question":"x"}', [])).toBe('{"question":"x"}');
  });
});

describe('the two gates the live run proved wrong', () => {
  it('accepts a plan that recommends the ALTERNATIVE method, which the playbook allows', () => {
    // The playbook's own age gate ends "toddlers in beds usually need the chair method
    // instead", so a plan that reads the child's situation and switches is the playbook
    // working. The first live run failed this fixture, and the gate was the bug.
    const chair = [
      'The chair method is the one I would use here - sit beside her bed until she is asleep.',
      "Nights 4-7: move the chair a foot toward the door. I'll check in Friday.",
    ];

    expect(planViolations(chair, GROUNDING, 3)).toEqual([]);
  });

  it('still refuses a plan that names NEITHER method (the positive control)', () => {
    const neither = [
      'Start with a calm bedtime routine and be consistent about it every night.',
      "Nights 4-7: keep going, it settles. I'll check in Friday.",
    ];

    expect(planViolations(neither, GROUNDING, 3)).toContainEqual(
      expect.stringContaining('never names the method'),
    );
  });

  it('allows 911 on solids, because the verified playbook itself says it', () => {
    // Anaphylaxis IS the emergency the blanket no-siren rule was written to stop Hale
    // INVENTING. The solids playbook's doctorTriggers open "Call 911 now, not the
    // doctor: trouble breathing... after eating", and where the curated content says
    // it, Hale may.
    const solids: PlanGrounding = {
      ...GROUNDING,
      topic: 'solids',
      playbook: playbookFor('solids'),
      child: { ageMonths: 6, stage: 'newborn' },
    };
    const plan = [
      'Week 1: one iron-first food a day - iron-fortified cereal or pureed meat.',
      "Week 2: allergens one at a time. Trouble breathing after eating is a 911 situation. I'll check in Friday.",
    ];

    expect(planViolations(plan, solids, 3).filter((v) => v.includes('911'))).toEqual([]);
  });

  it('still refuses 911 on sleep, where no trigger sanctions it (the positive control)', () => {
    const siren = [GOOD[0] as string, 'If the waking gets worse, call 911. Friday.'];

    expect(planViolations(siren, GROUNDING, 3).some((v) => v.includes('911'))).toBe(true);
  });
});
