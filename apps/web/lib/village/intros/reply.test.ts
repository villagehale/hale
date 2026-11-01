import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { ConsentReadingResult } from '~/lib/channel/consent-reply';
import type { SaidLineInput } from '~/lib/channel/voice/said-line';
import {
  type AnswerableProposal,
  INTRO_MUST_CONVEY,
  INTRO_REPLY_FACTS,
  type IntroDecision,
  type IntroReplySituation,
  type IntroStanding,
  type VillageIntroReplyDeps,
  handleVillageIntroReply,
  introStanding,
  proposalStanding,
  writeIntroReply,
  repeatedAnswer,
} from './reply';

/**
 * The readings the old keyword fixtures would have produced. The handler no longer
 * parses them. This map is the injected model.
 */
function fixtureIntro(text: string): ConsentReadingResult | null {
  const folded = text.trim().toLowerCase().replace(/[!.,]/g, '').replace(/\s+/g, ' ');
  const table: Record<string, ConsentReadingResult> = {
    'yes intros': { verdict: 'yes', target: 'discoverability' },
    'no intros': { verdict: 'no', target: 'discoverability' },
    'stop intros': { verdict: 'no', target: 'discoverability' },
    'nope intros': { verdict: 'no', target: 'discoverability' },
    'yes, intros please': { verdict: 'yes', target: 'discoverability' },
    'yes intro': { verdict: 'yes', target: 'proposal' },
    'yeah intro': { verdict: 'yes', target: 'proposal' },
    'no intro': { verdict: 'no', target: 'proposal' },
    我想认识附近的家庭: { verdict: 'yes', target: 'discoverability' },
    'لا أريد تعارف': { verdict: 'no', target: 'discoverability' },
  };
  return table[folded] ?? null;
}

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

/** What the stub writer returns: the model's words, not product copy. */
const MODEL_YES_ACK = 'model-written ack';

/** The stub's line for one intro_reply situation, keyed on the facts it was handed. */
function line(situation: IntroReplySituation): string {
  return `model:${INTRO_REPLY_FACTS[situation].situation}`;
}

function stubLine(input: SaidLineInput): string {
  return input.purpose === 'intro_yes' ? MODEL_YES_ACK : `model:${String(input.facts.situation)}`;
}

function deps(open: AnswerableProposal | null = null, standing: IntroStanding = 'unanswered') {
  const recordDiscoverability = vi.fn(async () => {});
  const recordDecision = vi.fn(async (_db: Database, _decision: IntroDecision) => {});
  const cancelOpenProposals = vi.fn(async () => {});
  // Stands in for the model (said-line): a canned write in a test, never a paid call.
  const saidLineWrite = vi.fn(
    async (input: SaidLineInput): Promise<string | null> => stubLine(input),
  );
  const spies: VillageIntroReplyDeps = {
    consent: { read: async ({ text }) => fixtureIntro(text) },
    recordDiscoverability,
    discoverabilityStanding: async () => standing,
    answerableProposal: async () => open,
    recordDecision,
    cancelOpenProposals,
    saidLine: { write: saidLineWrite },
  };
  return { spies, recordDiscoverability, recordDecision, cancelOpenProposals, saidLineWrite };
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
    expect(outcome).toEqual({
      status: 'discoverability_granted',
      reply: line('discoverability_on'),
    });
    expect(recordDiscoverability).toHaveBeenCalledWith(DB, {
      familyId: FAMILY_A,
      userId: 'u-a',
      granted: true,
      verbatimReply: 'Yes intros!',
      channelMessageId: null,
      reading: { readBy: 'consent-reply', confidence: 'high' },
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
    expect(outcome).toEqual({
      status: 'discoverability_revoked',
      reply: line('discoverability_off'),
    });
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
    expect(outcome).toEqual({ status: 'no_open_intro', reply: line('no_open_intro') });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('a first yes does NOT complete the pair', async () => {
    const { spies, recordDecision } = deps(proposal());
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: 'intro_accepted', reply: MODEL_YES_ACK });
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
    expect(outcome).toEqual({ status: 'intro_declined', reply: line('intro_no') });
    expect(recordDecision).toHaveBeenCalledWith(
      DB,
      expect.objectContaining({ granted: false, bothAccepted: false }),
    );
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
      reply: line('discoverability_already_on'),
    });
    expect(outcome.status === 'discoverability_unchanged' && outcome.reply).not.toBe(
      line('discoverability_on'),
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
      reply: line('discoverability_already_off'),
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

    expect(outcome).toEqual({
      status: 'discoverability_revoked',
      reply: line('discoverability_off'),
    });
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

    expect(outcome).toEqual({
      status: 'discoverability_granted',
      reply: line('discoverability_on'),
    });
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

    expect(outcome).toEqual({
      status: 'discoverability_revoked',
      reply: line('discoverability_off'),
    });
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

    expect(outcome).toEqual({ status: 'intro_unchanged', reply: line('intro_already_yes') });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('acknowledges a repeated NO briefly', async () => {
    const { spies, recordDecision } = deps(asked('declined'));

    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: 'NO INTRO', now: NOW },
      spies,
    );

    expect(outcome).toEqual({ status: 'intro_unchanged', reply: line('intro_already_no') });
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

    expect(outcome).toEqual({ status: 'intro_declined', reply: line('intro_no') });
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

    expect(outcome).toEqual({ status: 'intro_closed', reply: line('intro_closed') });
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

    expect(outcome).toEqual({ status: 'intro_accepted', reply: MODEL_YES_ACK });
    expect(recordDecision).toHaveBeenCalled();
  });
});

describe("the yes acknowledgement is the model's, or nothing", () => {
  const yes = { familyId: FAMILY_A, parentUserId: 'u-a', body: 'YES INTRO', now: NOW };

  it("sends what the model wrote, from the parent's words and the facts", async () => {
    const { spies, saidLineWrite, recordDecision } = deps(proposal());
    const outcome = await handleVillageIntroReply(DB, yes, spies);
    expect(outcome).toEqual({ status: 'intro_accepted', reply: MODEL_YES_ACK });
    expect(recordDecision).toHaveBeenCalled();
    expect(saidLineWrite).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'intro_yes', parentWords: 'YES INTRO' }),
    );
  });

  it('records the yes and sends nothing when the model cannot write one', async () => {
    const { spies, saidLineWrite, recordDecision } = deps(proposal());
    saidLineWrite.mockResolvedValueOnce(null);
    const outcome = await handleVillageIntroReply(DB, yes, spies);
    expect(outcome).toEqual({ status: 'intro_accepted', reply: null });
    expect(recordDecision).toHaveBeenCalled();
  });

  it('records the yes and sends nothing with no writer wired', async () => {
    const { spies, recordDecision } = deps(proposal());
    const outcome = await handleVillageIntroReply(DB, yes, { ...spies, saidLine: undefined });
    expect(outcome).toEqual({ status: 'intro_accepted', reply: null });
    expect(recordDecision).toHaveBeenCalled();
  });

  it('does not hand the model a group-text promise while the groups flag is off', async () => {
    vi.stubEnv('VILLAGE_INTRO_GROUPS_ENABLED', '');
    try {
      const { spies, saidLineWrite } = deps(proposal());
      await handleVillageIntroReply(DB, yes, spies);
      const off = saidLineWrite.mock.calls[0]?.[0];
      vi.stubEnv('VILLAGE_INTRO_GROUPS_ENABLED', 'true');
      const on = deps(proposal());
      await handleVillageIntroReply(DB, yes, on.spies);
      const onInput = on.saidLineWrite.mock.calls[0]?.[0];
      expect(off?.facts.groupText).not.toEqual(onInput?.facts.groupText);
      expect(off?.facts.groupText).toMatch(/^none/);
    } finally {
      vi.unstubAllEnvs();
    }
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

describe("VIL-450: every other intro reply is the model's, or nothing", () => {
  const cases: Array<{
    name: string;
    open: AnswerableProposal | null;
    standing: IntroStanding;
    body: string;
    status: string;
    situation: IntroReplySituation;
    recorded: 'discoverability' | 'decision' | 'none';
  }> = [
    {
      name: 'opt-in',
      open: null,
      standing: 'unanswered',
      body: 'yes intros',
      status: 'discoverability_granted',
      situation: 'discoverability_on',
      recorded: 'discoverability',
    },
    {
      name: 'opt-out',
      open: null,
      standing: 'granted',
      body: 'no intros',
      status: 'discoverability_revoked',
      situation: 'discoverability_off',
      recorded: 'discoverability',
    },
    {
      name: 'repeat opt-in',
      open: null,
      standing: 'granted',
      body: 'yes intros',
      status: 'discoverability_unchanged',
      situation: 'discoverability_already_on',
      recorded: 'none',
    },
    {
      name: 'repeat opt-out',
      open: null,
      standing: 'declined',
      body: 'no intros',
      status: 'discoverability_unchanged',
      situation: 'discoverability_already_off',
      recorded: 'none',
    },
    {
      name: 'no card',
      open: null,
      standing: 'granted',
      body: 'yes intro',
      status: 'no_open_intro',
      situation: 'no_open_intro',
      recorded: 'none',
    },
    {
      name: 'no to a card',
      open: proposal(),
      standing: 'granted',
      body: 'no intro',
      status: 'intro_declined',
      situation: 'intro_no',
      recorded: 'decision',
    },
    {
      name: 'repeat yes',
      open: proposal({ standing: 'granted' }),
      standing: 'granted',
      body: 'yes intro',
      status: 'intro_unchanged',
      situation: 'intro_already_yes',
      recorded: 'none',
    },
    {
      name: 'repeat no',
      open: proposal({ standing: 'declined' }),
      standing: 'granted',
      body: 'no intro',
      status: 'intro_unchanged',
      situation: 'intro_already_no',
      recorded: 'none',
    },
    {
      name: 'yes after no',
      open: proposal({ standing: 'declined' }),
      standing: 'granted',
      body: 'yes intro',
      status: 'intro_closed',
      situation: 'intro_closed',
      recorded: 'none',
    },
  ];

  it.each(cases)("$name: hands the model the situation facts and the parent's words", async (c) => {
    const { spies, saidLineWrite } = deps(c.open, c.standing);
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: c.body, now: NOW },
      spies,
    );
    expect(outcome).toEqual({ status: c.status, reply: line(c.situation) });
    expect(saidLineWrite).toHaveBeenCalledWith({
      purpose: 'intro_reply',
      language: null,
      parentWords: c.body,
      facts: INTRO_REPLY_FACTS[c.situation],
      ...(INTRO_MUST_CONVEY[c.situation] ? { mustConvey: INTRO_MUST_CONVEY[c.situation] } : {}),
    });
  });

  it.each(cases)(
    '$name: an unusable write sends nothing and the state change stands',
    async (c) => {
      const { spies, saidLineWrite, recordDiscoverability, recordDecision } = deps(
        c.open,
        c.standing,
      );
      saidLineWrite.mockResolvedValue(null);
      const outcome = await handleVillageIntroReply(
        DB,
        { familyId: FAMILY_A, parentUserId: 'u-a', body: c.body, now: NOW },
        spies,
      );
      expect(outcome).toEqual({ status: c.status, reply: null });
      expect(recordDiscoverability).toHaveBeenCalledTimes(c.recorded === 'discoverability' ? 1 : 0);
      expect(recordDecision).toHaveBeenCalledTimes(c.recorded === 'decision' ? 1 : 0);
    },
  );

  it.each(cases)('$name: no writer wired sends nothing (no fixed fallback)', async (c) => {
    const { spies } = deps(c.open, c.standing);
    const outcome = await handleVillageIntroReply(
      DB,
      { familyId: FAMILY_A, parentUserId: 'u-a', body: c.body, now: NOW },
      { ...spies, saidLine: undefined },
    );
    expect(outcome).toEqual({ status: c.status, reply: null });
  });

  it('never hands the model a fact about the other family, nor why a pair died', () => {
    // Structural, not wording: the facts are all the writer sees.
    for (const [situation, facts] of Object.entries(INTRO_REPLY_FACTS)) {
      expect(JSON.stringify(facts), situation).not.toMatch(/fam-|parentName|familyId/);
    }
    expect(JSON.stringify(INTRO_REPLY_FACTS.soft_close)).not.toMatch(
      /they said no|declined|expired|ran out|did not answer/i,
    );
  });
});

describe('#919: guardrails are writer constraints, not facts to be voiced', () => {
  it('no intro situation carries an instruction-shaped fact key', () => {
    for (const [situation, facts] of Object.entries(INTRO_REPLY_FACTS)) {
      for (const key of ['otherFamily', 'reason', 'match']) {
        expect(facts, situation).not.toHaveProperty(key);
      }
    }
  });
});

describe('#919: switching introductions off always conveys that pending ones are closed', () => {
  it('discoverability_off requires the pendingClosed fact by key, and that fact exists', () => {
    expect(INTRO_MUST_CONVEY.discoverability_off).toEqual(['pendingClosed']);
    expect(INTRO_REPLY_FACTS.discoverability_off).toHaveProperty('pendingClosed');
    for (const [situation, keys] of Object.entries(INTRO_MUST_CONVEY)) {
      for (const key of keys ?? []) {
        expect(INTRO_REPLY_FACTS[situation as keyof typeof INTRO_REPLY_FACTS], situation).toHaveProperty(key);
      }
    }
  });

  it('the revocation hands the writer mustConvey [pendingClosed]', async () => {
    const write = vi.fn().mockResolvedValue('ok');
    await writeIntroReply({ write }, 'discoverability_off', 'no more intros');
    expect(write.mock.calls[0]?.[0]).toMatchObject({ mustConvey: ['pendingClosed'] });
    write.mockClear();
    await writeIntroReply({ write }, 'intro_no', 'no thanks');
    expect(write.mock.calls[0]?.[0]).not.toHaveProperty('mustConvey');
  });
});

describe('the said-line eval replays these exact facts', () => {
  it('said-line-fixtures.mjs INTRO_REPLY_FACTS matches reply.ts key for key', async () => {
    // The eval replicates the facts (it cannot reach `~/`); the cache key depends on them.
    const path = '../../../../worker/evals/said-line-fixtures.mjs';
    const fixtures = (await import(/* @vite-ignore */ path)) as {
      INTRO_REPLY_FACTS: unknown;
    };
    expect(fixtures.INTRO_REPLY_FACTS).toEqual(INTRO_REPLY_FACTS);
    expect((fixtures as unknown as { INTRO_MUST_CONVEY: unknown }).INTRO_MUST_CONVEY).toEqual(
      INTRO_MUST_CONVEY,
    );
  });
});

describe('#919: standing is the parent\'s own state, and an open parent knows Hale texts on a match', () => {
  const situations = Object.entries(INTRO_REPLY_FACTS) as Array<[string, Record<string, string>]>;
  it('every situation where the parent is open carries the match-text fact (run.ts cardUnaskedSides)', () => {
    for (const [name, facts] of situations) {
      if (!('standing' in facts)) continue;
      const open = name !== 'discoverability_off' && name !== 'discoverability_already_off';
      expect(['matchText' in facts, name]).toEqual([open, name]);
    }
  });
  it('the switched-off situations promise no match text', () => {
    expect('matchText' in INTRO_REPLY_FACTS.discoverability_off).toBe(false);
    expect('matchText' in INTRO_REPLY_FACTS.discoverability_already_off).toBe(false);
  });
});
