import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCOVERABILITY_ALREADY_OFF,
  INTRO_ALREADY_NO,
  INTRO_ALREADY_YES,
  INTRO_CLOSED_AFTER_NO,
  DISCOVERABILITY_ALREADY_ON,
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_NO_ACK,
  INTRO_YES_ACK,
  NO_OPEN_INTRO,
} from './copy';
import {
  type AnswerableProposal,
  type IntroDecision,
  type IntroStanding,
  introStanding,
  proposalStanding,
  repeatedAnswer,
  type VillageIntroReplyDeps,
  handleVillageIntroReply,
  matchIntroKeyword,
} from './reply';

/**
 * The keyword layer is where a parent's word becomes a decision, so it is tested apart
 * from the database work: these are the exact strings a live test will type, and the
 * ones that must NOT be claimed by this lane at all.
 */
describe('matchIntroKeyword', () => {
  it('reads the two discoverability keywords', () => {
    expect(matchIntroKeyword('YES INTROS')).toEqual({ target: 'discoverability', granted: true });
    expect(matchIntroKeyword('NO INTROS')).toEqual({ target: 'discoverability', granted: false });
  });

  it('reads the two per-intro keywords', () => {
    expect(matchIntroKeyword('YES INTRO')).toEqual({ target: 'proposal', granted: true });
    expect(matchIntroKeyword('NO INTRO')).toEqual({ target: 'proposal', granted: false });
  });

  it('survives how a phone actually sends them', () => {
    expect(matchIntroKeyword('yes intros')).toEqual({ target: 'discoverability', granted: true });
    expect(matchIntroKeyword('  Yes, intros please  ')).toEqual({
      target: 'discoverability',
      granted: true,
    });
    expect(matchIntroKeyword('Yeah intro')).toEqual({ target: 'proposal', granted: true });
    expect(matchIntroKeyword('nope intros')).toEqual({
      target: 'discoverability',
      granted: false,
    });
  });

  it('reads STOP INTROS as a revocation, not as a CASL unsubscribe', () => {
    // Bare STOP is a carrier keyword handled long before this lane; STOP INTROS is a
    // parent scoping their refusal to one thing, and reading it as anything else either
    // over-unsubscribes them or ignores them.
    expect(matchIntroKeyword('STOP INTROS')).toEqual({
      target: 'discoverability',
      granted: false,
    });
  });

  it('leaves a bare yes or no alone - they belong to whatever Hale last asked', () => {
    expect(matchIntroKeyword('yes')).toBeNull();
    expect(matchIntroKeyword('no')).toBeNull();
    expect(matchIntroKeyword('YES 2')).toBeNull();
  });

  it('does not claim a sentence that merely mentions intros', () => {
    expect(matchIntroKeyword('can you tell me more about intros')).toBeNull();
    expect(matchIntroKeyword('what is an intro')).toBeNull();
    expect(matchIntroKeyword('intros')).toBeNull();
  });

  it('does not claim a carrier keyword', () => {
    expect(matchIntroKeyword('STOP')).toBeNull();
    expect(matchIntroKeyword('unsubscribe')).toBeNull();
    expect(matchIntroKeyword('HELP')).toBeNull();
  });
});

const DB = {} as Database;
const NOW = new Date('2026-08-11T15:00:00Z');
const FAMILY_A = 'fam-a';
const FAMILY_B = 'fam-b';

function proposal(overrides: Partial<AnswerableProposal> = {}): AnswerableProposal {
  return {
    id: 'prop-1',
    familyAId: FAMILY_A,
    familyBId: FAMILY_B,
    familyAReply: null,
    familyBReply: null,
    standing: 'unanswered',
    ...overrides,
  };
}

function deps(open: AnswerableProposal | null = null, standing: IntroStanding = 'unanswered') {
  const recordDiscoverability = vi.fn(async () => {});
  const recordDecision = vi.fn(async (_db: Database, _decision: IntroDecision) => {});
  const cancelOpenProposals = vi.fn(async () => {});
  const spies: VillageIntroReplyDeps = {
    recordDiscoverability,
    discoverabilityStanding: async () => standing,
    answerableProposal: async () => open,
    recordDecision,
    cancelOpenProposals,
  };
  return { spies, recordDiscoverability, recordDecision, cancelOpenProposals };
}

describe('handleVillageIntroReply', () => {
  it('does not claim anything that is not an intro keyword', async () => {
    const { spies, recordDiscoverability, recordDecision } = deps();
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'can we move swim to Tuesday', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'declined_to_claim' });
    expect(recordDiscoverability).not.toHaveBeenCalled();
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('records the opt-in verbatim and cancels nothing', async () => {
    const { spies, recordDiscoverability, cancelOpenProposals } = deps();
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'Yes intros!', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'discoverability_granted', reply: DISCOVERABILITY_ON });
    expect(recordDiscoverability).toHaveBeenCalledWith(DB, {
      familyId: FAMILY_A,
      userId: 'u-a',
      granted: true,
      verbatimReply: 'Yes intros!',
      channelMessageId: null,
      // A typed keyword: no confidence, because it either matched or it did not.
      reading: { readBy: 'keyword', confidence: null },
    });
    expect(cancelOpenProposals).not.toHaveBeenCalled();
  });

  it('revocation writes granted=false with the parents own words AND cancels open proposals', async () => {
    const { spies, recordDiscoverability, cancelOpenProposals } = deps(null, 'granted');
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'NO INTROS', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'discoverability_revoked', reply: DISCOVERABILITY_OFF });
    expect(recordDiscoverability).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: false, verbatimReply: 'NO INTROS' }),
    );
    expect(cancelOpenProposals).toHaveBeenCalledWith(DB, FAMILY_A, NOW);
  });

  it('answers an intro keyword honestly when no card is waiting, and writes nothing', async () => {
    const { spies, recordDecision } = deps(null);
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'no_open_intro', reply: NO_OPEN_INTRO });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('a first yes does NOT complete the pair', async () => {
    const { spies, recordDecision } = deps(proposal());
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'intro_accepted', reply: INTRO_YES_ACK });
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ side: 'a', granted: true, bothAccepted: false }),
    );
  });

  it('the SECOND yes completes the pair, from either side', async () => {
    const { spies, recordDecision } = deps(proposal({ familyAReply: 'yes' }));
    await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_B, parentUserId: 'u-b', body: 'yes intro', now: NOW },
      spies,
    );
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ side: 'b', granted: true, bothAccepted: true }),
    );
  });

  it('a yes opposite a NO never completes the pair', async () => {
    const { spies, recordDecision } = deps(proposal({ familyAReply: 'no' }));
    await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_B, parentUserId: 'u-b', body: 'yes intro', now: NOW },
      spies,
    );
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: true, bothAccepted: false }),
    );
  });

  it('a no is recorded as a decline and acknowledged without mentioning the other side', async () => {
    const { spies, recordDecision } = deps(proposal({ familyAReply: 'yes' }));
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_B, parentUserId: 'u-b', body: 'no intro', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'intro_declined', reply: INTRO_NO_ACK });
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: false, bothAccepted: false }),
    );
    expect(INTRO_NO_ACK.toLowerCase()).not.toContain('they');
  });
});

/**
 * THE 09:47:48 -> 09:47:59 CASE, from the founder's live test on 2026-08-13.
 *
 * Hale asked at 08:01. At 09:47:48 the parent replied "Yes" — which the keyword machine
 * could not read, so it went to the coach and came back about a stale calendar draft. At
 * 09:47:59, getting no traction, they retyped "Yes intros", and the keyword handler
 * answered THAT. Two contradictory replies, eleven seconds apart.
 *
 * The bare "Yes" is the resolver's half and is covered in the router tests. This is the
 * other half: the retype must not be answered as if it were a fresh decision. A parent who
 * texts twice because they think the first one did not land is not making a second choice.
 */
describe('a second affirmation of an answer already given', () => {
  it('does not write a second consent row', async () => {
    const { spies, recordDiscoverability } = deps(null, 'granted');

    await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'Yes intros', now: NOW },
      spies,
    );

    expect(recordDiscoverability).not.toHaveBeenCalled();
  });

  it('answers briefly rather than repeating the whole acknowledgement', async () => {
    const { spies } = deps(null, 'granted');

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'Yes intros', now: NOW },
      spies,
    );

    // Answered, because silence reads as the second text not landing either — but not
    // with the full "Nothing is shared until you both say yes" ack for a second time.
    expect(outcome).toEqual({
      status: 'discoverability_unchanged',
      reply: DISCOVERABILITY_ALREADY_ON,
    });
    expect(outcome.status === 'discoverability_unchanged' && outcome.reply).not.toBe(
      DISCOVERABILITY_ON,
    );
  });

  it('acknowledges a repeated NO the same way', async () => {
    const { spies, recordDiscoverability, cancelOpenProposals } = deps(null, 'declined');

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'no intros', now: NOW },
      spies,
    );

    expect(outcome).toEqual({
      status: 'discoverability_unchanged',
      reply: DISCOVERABILITY_ALREADY_OFF,
    });
    expect(recordDiscoverability).not.toHaveBeenCalled();
    expect(cancelOpenProposals).not.toHaveBeenCalled();
  });

  it('ALWAYS honours a revocation, even seconds after the grant', async () => {
    // The one thing this shortcut may never swallow. A parent changing their mind is not
    // a duplicate, and a revocation that gets deduplicated is not a revocation.
    const { spies, recordDiscoverability, cancelOpenProposals } = deps(null, 'granted');

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'no intros', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'discoverability_revoked', reply: DISCOVERABILITY_OFF });
    expect(recordDiscoverability).toHaveBeenCalled();
    expect(cancelOpenProposals).toHaveBeenCalled();
  });

  it('still records a genuine first yes', async () => {
    // Non-vacuity: the shortcut is about the standing answer, not about the word.
    const { spies, recordDiscoverability } = deps(null, 'unanswered');

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'Yes intros', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'discoverability_granted', reply: DISCOVERABILITY_ON });
    expect(recordDiscoverability).toHaveBeenCalled();
  });
});

/**
 * A FIRST "no intros" MUST still be recorded.
 *
 * `unanswered` and `declined` are the same boolean and completely different facts, and
 * this is what happens when they are collapsed: the decline is answered with "already
 * off", no row is written, the matcher cannot see the refusal, and the family gets asked
 * again. The tri-state exists for this test.
 */
describe('introStanding', () => {
  it('tells a silence from a refusal', () => {
    // The handler tests below STUB the standing reader, so they cannot see this collapse.
    // Only a direct test of the decision can: fold `unanswered` into `declined` and every
    // one of them still passes while production swallows each family's first "no intros".
    expect(introStanding({ answered: false, granted: false })).toBe('unanswered');
    expect(introStanding({ answered: true, granted: false })).toBe('declined');
    expect(introStanding({ answered: true, granted: true })).toBe('granted');
  });
});

describe('a first refusal is never mistaken for a repeat', () => {
  it('writes the decline row even though nothing changes for the matcher', async () => {
    const { spies, recordDiscoverability } = deps(null, 'unanswered');

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'no intros', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'discoverability_revoked', reply: DISCOVERABILITY_OFF });
    expect(recordDiscoverability).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: false }),
    );
  });
});

/**
 * THE SAME DEFECT ON THE PROPOSAL CARD.
 *
 * A repeated affirmation to a question Hale has already recorded reads as Hale forgetting,
 * and it does not matter which of the two questions it was. This half was worse than the
 * opt-in half: `loadOpenProposal` required `reply IS NULL`, so a parent who answered and
 * then texted again got "I don't have an intro waiting for you right now" seconds after
 * "I'll introduce you both by email" — and, far worse, a parent WITHDRAWING before the
 * introduction was sent was silently ignored and the email went anyway.
 */
describe('answering a proposal card that already has this side answered', () => {
  const asked = (standing: IntroStanding): AnswerableProposal => ({
    id: 'p-1',
    familyAId: FAMILY_A,
    familyBId: FAMILY_B,
    familyAReply: standing === 'unanswered' ? null : standing === 'granted' ? 'yes' : 'no',
    familyBReply: null,
    standing,
  });

  it('acknowledges a repeated YES briefly instead of denying the intro exists', async () => {
    const { spies, recordDecision } = deps(asked('granted'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_unchanged', reply: INTRO_ALREADY_YES });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('acknowledges a repeated NO briefly', async () => {
    const { spies, recordDecision } = deps(asked('declined'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'NO INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_unchanged', reply: INTRO_ALREADY_NO });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('HONOURS a withdrawal after a yes, before the introduction goes out', async () => {
    // The consent bug the widened read exposes. `reply IS NULL` made an already-answered
    // side invisible, so "NO INTRO" after "YES INTRO" was answered with "I don't have an
    // intro waiting" and the sweep sent the email anyway (rule #4).
    const { spies, recordDecision } = deps(asked('granted'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'NO INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_declined', reply: INTRO_NO_ACK });
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: false, bothAccepted: false }),
    );
  });

  it('does not re-open a pairing the parent already refused', async () => {
    // The other side has been soft-closed by now. Saying yes cannot un-send that.
    const { spies, recordDecision } = deps(asked('declined'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_closed', reply: INTRO_CLOSED_AFTER_NO });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('still records a genuine first answer', async () => {
    // Non-vacuity: the shortcut is about the standing answer, not about the card.
    const { spies, recordDecision } = deps(asked('unanswered'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_accepted', reply: INTRO_YES_ACK });
    expect(recordDecision).toHaveBeenCalled();
  });
});

describe('proposalStanding', () => {
  const pair = (a: 'yes' | 'no' | null, b: 'yes' | 'no' | null) => ({
    familyAId: FAMILY_A,
    familyAReply: a,
    familyBReply: b,
  });

  it('reads each family its OWN answer, not the pairs', () => {
    // One row, two sides. Reading the wrong column reports the counterpart's answer back
    // to this family — a wrong receipt AND a cross-household read (rule #1) — and every
    // handler test above injects a ready-made `standing`, so only this can see it.
    expect(proposalStanding(pair('yes', null), FAMILY_A)).toBe('granted');
    expect(proposalStanding(pair('yes', null), FAMILY_B)).toBe('unanswered');
    expect(proposalStanding(pair(null, 'no'), FAMILY_B)).toBe('declined');
    expect(proposalStanding(pair(null, 'no'), FAMILY_A)).toBe('unanswered');
  });

  it('tells an unanswered card from a refused one', () => {
    expect(proposalStanding(pair(null, null), FAMILY_A)).toBe('unanswered');
    expect(proposalStanding(pair('no', null), FAMILY_A)).toBe('declined');
  });
});

/**
 * ONE PRIMITIVE, BOTH QUESTIONS. The whole point of the shared function: the rule cannot
 * be right for the opt-in and wrong for the card, because there is only one of it.
 */
describe('repeatedAnswer', () => {
  it('is true only when the new answer is the one already on file', () => {
    expect(repeatedAnswer('granted', true)).toBe(true);
    expect(repeatedAnswer('declined', false)).toBe(true);
  });

  it('is false for a change of mind - a NO after a YES is always a decision', () => {
    expect(repeatedAnswer('granted', false)).toBe(false);
    expect(repeatedAnswer('declined', true)).toBe(false);
  });

  it('is false when nothing is on file, so a first answer is never swallowed', () => {
    expect(repeatedAnswer('unanswered', true)).toBe(false);
    expect(repeatedAnswer('unanswered', false)).toBe(false);
  });
});
