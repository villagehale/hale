import { describe, expect, it } from 'vitest';
import {
  type OpenQuestion,
  type OpenQuestionKind,
  createOpenQuestionReader,
  newestSolicitedKind,
  soleOpenKind,
} from './open-questions';

/**
 * The bare-affirmative binding rules over the open-question list.
 *
 * The 2026-08-28 ads-week audit: an outbound ending "Reply YES ..." — an EXPLICIT
 * solicited-keyword ask — was answered with a bare YES minutes later, and the YES fell
 * to an older open question instead. A parent (or the founder) doing exactly what the
 * last message told them to do must land on that message's question.
 *
 * The precedence is deliberately narrow: it fires only when every open question's ask
 * time is KNOWN and the newest one is a solicited-keyword ask. Anything else — mixed
 * kinds with no solicited ask, an undated question in the list, a tie — keeps the
 * 2026-08-13 rule: nobody claims, the resolver reads or Hale asks.
 */

const T0 = new Date('2026-08-28T00:00:00.000Z');
const T1 = new Date('2026-08-28T01:00:00.000Z');

function question(
  kind: OpenQuestionKind,
  overrides: Partial<OpenQuestion> = {},
): OpenQuestion {
  return {
    id: `${kind}-1`,
    kind,
    description: `an open ${kind} question`,
    subject: kind,
    answerable: { yes: true, no: true },
    askedAt: null,
    solicited: false,
    ...overrides,
  };
}

describe('newest-solicited precedence (ads-week audit, 2026-08-28)', () => {
  it('binds a bare YES to the newest ask when it printed "Reply YES ..."', () => {
    const questions = [
      question('activity_followup', { askedAt: T0 }),
      question('founder_welcome_offer', { askedAt: T1, solicited: true }),
    ];
    expect(newestSolicitedKind(questions)).toBe('founder_welcome_offer');
    expect(soleOpenKind(questions, 'founder_welcome_offer')).toBe(true);
    // The older question gains nothing: only the newest solicited ask wins.
    expect(soleOpenKind(questions, 'activity_followup')).toBe(false);
  });

  it('changes nothing when no ask was solicited — the 2026-08-13 rule stands (pin)', () => {
    const questions = [
      question('activity_followup', { askedAt: T0 }),
      question('checkup_offer', { askedAt: T1 }),
    ];
    expect(newestSolicitedKind(questions)).toBeNull();
    expect(soleOpenKind(questions, 'checkup_offer')).toBe(false);
    expect(soleOpenKind(questions, 'activity_followup')).toBe(false);
  });

  it('fails closed when any open question has no known ask time', () => {
    const questions = [
      question('approval'),
      question('founder_welcome_offer', { askedAt: T1, solicited: true }),
    ];
    // An approval's ask time is not threaded, so recency cannot be established — and a
    // bare YES near an open approval is exactly the coin flip the old priority rule
    // resolved wrongly. Nobody claims; the resolver or a clarifying sentence takes it.
    expect(newestSolicitedKind(questions)).toBeNull();
    expect(soleOpenKind(questions, 'founder_welcome_offer')).toBe(false);
  });

  it('fails closed on a tie at the top', () => {
    const questions = [
      question('plan_offer', { askedAt: T1, solicited: true }),
      question('checkup_offer', { askedAt: T1 }),
    ];
    expect(newestSolicitedKind(questions)).toBeNull();
  });

  it('an older solicited ask does not outrank a newer plain one', () => {
    const questions = [
      question('plan_offer', { askedAt: T0, solicited: true }),
      question('checkup_offer', { askedAt: T1 }),
    ];
    expect(newestSolicitedKind(questions)).toBeNull();
    expect(soleOpenKind(questions, 'plan_offer')).toBe(false);
  });

  it('a single open question still binds exactly as before (pin)', () => {
    const solo = [question('plan_offer', { askedAt: T0, solicited: true })];
    expect(soleOpenKind(solo, 'plan_offer')).toBe(true);
    expect(soleOpenKind([question('checkup_offer')], 'checkup_offer')).toBe(true);
    expect(soleOpenKind([], null)).toBe(true);
  });
});

describe('the reader stamps recency and solicitation from the owning rows', () => {
  it('carries askedAt off the commitment rows and marks the keyword-printing kinds', async () => {
    const reader = createOpenQuestionReader({
      pendingApprovals: async () => [],
      introOptInOpen: async () => false,
      introProposal: async () => null,
      planOffer: async () => ({ id: 'plan-1', summary: 'a plan', askedAt: T0 }),
      checkupOffer: async () => null,
      founderWelcomeOffer: async () => ({ id: 'offer-1', summary: 'a note', askedAt: T1 }),
      activityPromise: async () => ({ id: 'promise-1', summary: 'a promise', askedAt: T0 }),
    });

    const questions = await reader.open({} as never, {
      familyId: 'fam-1',
      parentUserId: 'parent-1',
      now: T1,
    });

    const byKind = new Map(questions.map((q) => [q.kind, q]));
    // The two asks whose copy literally prints "Reply YES ..." (founder/copy.ts,
    // channel/plan/offer.ts) are solicited; the promise asks for nothing.
    expect(byKind.get('plan_offer')).toMatchObject({ askedAt: T0, solicited: true });
    expect(byKind.get('founder_welcome_offer')).toMatchObject({ askedAt: T1, solicited: true });
    expect(byKind.get('activity_followup')).toMatchObject({ askedAt: T0, solicited: false });
    expect(newestSolicitedKind(questions)).toBe('founder_welcome_offer');
  });
});
