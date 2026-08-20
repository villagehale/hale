import { describe, expect, it } from 'vitest';
import type { OpenQuestion } from './open-questions';
import {
  meetsGrade,
  readingSchema,
  replyResolverUserMessage,
  toReading,
  warrantsClarifying,
} from './resolve';

/**
 * The DECISION half of natural reply resolution — everything that happens to a model's
 * answer after it arrives. Its quality (does it read "not this time" as a no) is a
 * separate eval against real cached Claude, apps/worker/evals/run-reply-resolver-eval.mjs
 * (rule #8).
 *
 * What is pinned here is the part a bad model must not be able to get past: an id it was
 * never offered, a confidence too low for what the answer would do, and a polarity the
 * owning module has nowhere to put.
 */

const APPROVAL: OpenQuestion = {
  id: 'action-1',
  kind: 'approval',
  description: 'Reschedule on your calendar',
  subject: 'reschedule on your calendar',
  answerable: { yes: true, no: true },
};

const PROPOSAL: OpenQuestion = {
  id: 'proposal-1',
  kind: 'intro_proposal',
  description: 'Whether to meet one nearby Hale family',
  subject: 'meeting the family nearby',
  answerable: { yes: true, no: true },
};

const OPT_IN: OpenQuestion = {
  id: 'intro_optin:fam-1',
  kind: 'intro_optin',
  description: 'Whether to be introduced to other Hale families nearby',
  subject: 'introductions to other Hale families nearby',
  answerable: { yes: true, no: true },
};

const OFFER: OpenQuestion = {
  id: 'commitment-1',
  kind: 'plan_offer',
  description: "A plan for the 4am wake-ups, in three texts",
  subject: 'the plan I offered',
  answerable: { yes: true, no: false },
};

const ALL = [APPROVAL, PROPOSAL, OPT_IN, OFFER];

function read(
  raw: { target: string; polarity: string; confidence: string },
  questions: readonly OpenQuestion[] = ALL,
) {
  return toReading(raw, questions);
}

describe('toReading', () => {
  it('resolves a confident answer to the question it names', () => {
    expect(read({ target: 'action-1', polarity: 'yes', confidence: 'high' })).toEqual({
      status: 'resolved',
      questionId: 'action-1',
      kind: 'approval',
      polarity: 'yes',
      confidence: 'high',
    });
  });

  describe('the grades - D17 read strictly', () => {
    it('acts on an ordinary question at medium confidence', () => {
      // Being too timid here recreates the problem the arc removes: a parent whose plain
      // English is ignored learns to type the magic word.
      expect(read({ target: OFFER.id, polarity: 'yes', confidence: 'medium' })).toMatchObject({
        status: 'resolved',
        kind: 'plan_offer',
      });
      expect(read({ target: OPT_IN.id, polarity: 'no', confidence: 'medium' })).toMatchObject({
        status: 'resolved',
        polarity: 'no',
      });
    });

    it('refuses a CALENDAR CHANGE at medium confidence', () => {
      expect(read({ target: APPROVAL.id, polarity: 'yes', confidence: 'medium' })).toEqual({
        status: 'unresolved',
        reason: 'below_grade',
      });
    });

    it('refuses a CROSS-HOUSEHOLD DISCLOSURE at medium confidence', () => {
      expect(read({ target: PROPOSAL.id, polarity: 'yes', confidence: 'medium' })).toEqual({
        status: 'unresolved',
        reason: 'below_grade',
      });
    });

    it('never acts on low confidence, whatever the class', () => {
      for (const question of ALL) {
        expect(
          read({ target: question.id, polarity: 'yes', confidence: 'low' }),
          `${question.kind} must not act on a guess`,
        ).toEqual({ status: 'unresolved', reason: 'below_grade' });
      }
    });

    it('treats a confidence word it does not recognise as low', () => {
      // Fail closed: an unparseable confidence is not a high one.
      expect(read({ target: OFFER.id, polarity: 'yes', confidence: 'quite' })).toEqual({
        status: 'unresolved',
        reason: 'below_grade',
      });
    });

    it('agrees with meetsGrade, which is the rule both halves read', () => {
      expect(meetsGrade('approval', 'medium')).toBe(false);
      expect(meetsGrade('approval', 'high')).toBe(true);
      expect(meetsGrade('plan_offer', 'medium')).toBe(true);
      expect(meetsGrade('plan_offer', 'low')).toBe(false);
    });
  });

  describe('the things a model must not be able to do', () => {
    it('refuses an id it was never offered', () => {
      // The single most dangerous output this stage can produce: an answer applied to a
      // question the parent was never asked. Checked by identity against the list sent.
      expect(read({ target: 'action-999', polarity: 'yes', confidence: 'high' })).toEqual({
        status: 'unresolved',
        reason: 'unreadable',
      });
    });

    it('refuses a plausible near-miss id rather than matching it loosely', () => {
      expect(read({ target: 'action-1 ', polarity: 'yes', confidence: 'high' })).toEqual({
        status: 'unresolved',
        reason: 'unreadable',
      });
    });

    it('records no answer for a polarity the owning module cannot store', () => {
      // A "no" to a plan offer has no writer - the offer lapses on its own. The coach
      // takes the turn and can say something true about it.
      expect(read({ target: OFFER.id, polarity: 'no', confidence: 'high' })).toEqual({
        status: 'unresolved',
        reason: 'not_answerable',
      });
    });
  });

  describe('an undecided parent is not an ambiguous one', () => {
    it.each(['unclear', 'maybe', ''])('reads polarity %j as no answer at all', (polarity) => {
      expect(read({ target: APPROVAL.id, polarity, confidence: 'high' })).toEqual({
        status: 'unresolved',
        reason: 'no_target',
      });
    });

    it('does not ask which question a maybe was about', () => {
      // "let me ask my partner" with three things open must not produce "which one?".
      const reading = read({ target: 'ambiguous', polarity: 'unclear', confidence: 'high' });
      expect(reading).toEqual({ status: 'unresolved', reason: 'no_target' });
      expect(warrantsClarifying('no_target')).toBe(false);
    });
  });

  describe('none vs ambiguous - the distinction that decides what the parent hears', () => {
    it('sends an ordinary message on to the coach', () => {
      expect(read({ target: 'none', polarity: 'yes', confidence: 'high' })).toEqual({
        status: 'unresolved',
        reason: 'no_target',
      });
      expect(warrantsClarifying('no_target')).toBe(false);
    });

    it('earns a clarifying question for an answer that names nothing', () => {
      expect(read({ target: 'ambiguous', polarity: 'yes', confidence: 'medium' })).toEqual({
        status: 'unresolved',
        reason: 'ambiguous',
      });
      expect(warrantsClarifying('ambiguous')).toBe(true);
    });

    it('also asks when the target is known but the certainty is not enough', () => {
      // "I think they meant the swim move" is exactly when to check rather than guess.
      expect(warrantsClarifying('below_grade')).toBe(true);
    });

    it('never asks because of an outage or a missing key', () => {
      for (const reason of ['client_unavailable', 'skill_unavailable', 'model_failed'] as const) {
        expect(warrantsClarifying(reason), reason).toBe(false);
      }
    });
  });
});

describe('the parse - what a truncated response must survive', () => {
  it('accepts a decision whose trailing reason never arrived', () => {
    // The live defect: `reason` is emitted last, a real question id eats ~30 of the 128
    // output tokens, and the response stops mid-reason. Anthropic does not hard enforce a
    // tool's input schema, so a complete decision arrived with one field missing and zod
    // threw — turning "yeah go ahead" into an outage the parent never heard about.
    expect(
      readingSchema.parse({ target: 'action-1', polarity: 'yes', confidence: 'high' }),
    ).toEqual({ target: 'action-1', polarity: 'yes', confidence: 'high' });
  });

  it('still refuses a response missing a field the decision is made of', () => {
    // Non-vacuity: optional applies to the decoration, not to the decision.
    expect(() => readingSchema.parse({ target: 'action-1', polarity: 'yes' })).toThrow();
  });
});

describe('replyResolverUserMessage', () => {
  it('sends the parents words and the ids, and nothing else about them', () => {
    const payload = JSON.parse(replyResolverUserMessage('yeah go ahead', [APPROVAL, PROPOSAL]));
    expect(payload).toEqual({
      text: 'yeah go ahead',
      questions: [
        { id: 'action-1', kind: 'approval', question: 'Reschedule on your calendar' },
        { id: 'proposal-1', kind: 'intro_proposal', question: 'Whether to meet one nearby Hale family' },
      ],
    });
  });

  it('never carries the other household - the proposal question names nobody', () => {
    const payload = replyResolverUserMessage('sure', [PROPOSAL]);
    for (const secret of ['Priya', 'Marisol', 'M4K 1N2', 'priya@example.com']) {
      expect(payload).not.toContain(secret);
    }
    // Non-vacuity: the question IS in there, it just carries no counterpart fact.
    expect(payload).toContain('nearby Hale family');
  });
});
