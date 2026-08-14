import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCOVERABILITY_OFF,
  DISCOVERABILITY_ON,
  INTRO_NO_ACK,
  INTRO_YES_ACK,
  NO_OPEN_INTRO,
} from './copy';
import {
  type IntroDecision,
  type OpenIntroProposal,
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

function proposal(overrides: Partial<OpenIntroProposal> = {}): OpenIntroProposal {
  return {
    id: 'prop-1',
    familyAId: FAMILY_A,
    familyBId: FAMILY_B,
    familyAReply: null,
    familyBReply: null,
    ...overrides,
  };
}

function deps(open: OpenIntroProposal | null = null) {
  const recordDiscoverability = vi.fn(async () => {});
  const recordDecision = vi.fn(async (_db: Database, _decision: IntroDecision) => {});
  const cancelOpenProposals = vi.fn(async () => {});
  const spies: VillageIntroReplyDeps = {
    recordDiscoverability,
    openProposal: async () => open,
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
    const { spies, recordDiscoverability, cancelOpenProposals } = deps();
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
