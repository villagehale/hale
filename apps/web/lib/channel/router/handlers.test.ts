import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotPortal } from '~/lib/channel/spots/url';
import type {
  PrepareReplyDeps,
  PreparingSequence,
} from '~/lib/registration/sequence/prepare-reply';
import { checkpointById, parseCheckpointRef } from '~/lib/health/checkpoints';
import type { OpenCheckupOffer } from '~/lib/health/offer';
import type { HealthReplyDeps } from '~/lib/health/reply';
import type { AwaitingSequence, SequenceReplyDeps } from '~/lib/registration/sequence/reply';
import type { VillageIntroReplyDeps } from '~/lib/village/intros/reply';
import type { ApprovalSpine, PendingAction } from './approval';
import {
  approvalHandler,
  healthReplyHandler,
  recMorningHandler,
  sequenceReplyHandler,
  villageIntroHandler,
} from './handlers';
import type { OpenQuestion } from './open-questions';
import type { HandlerContext, ResolvedAnswer } from './route';

/**
 * The two handlers C1 ships wired, and — more importantly — the seam between them.
 *
 * "yes" is the word both could claim. Which one gets it is the only genuinely
 * contested decision in this ticket, so it is pinned here in both directions: with a
 * drafted action waiting, and with none.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const DB = {} as Database;
/** The inbound `channel_messages` row this turn arrived on — what a handler writing a
 * parent-stated fact points its audit row at. */
const INBOUND_MESSAGE_ID = '44444444-4444-4444-8444-444444444444';

/**
 * `open` is what Hale is waiting to hear back about, and it gates every BARE affirmative:
 * a handler may only claim one when every open question is of its own kind
 * (`soleOpenKind`) — the rule that stops a "yes" meant for an intro card approving a
 * calendar write. Empty by default, which is vacuously "unambiguous" and is what the
 * pre-existing cases in this file assume.
 */
const turn = (
  body: string,
  options: { resolved?: ResolvedAnswer | null; open?: OpenQuestion[] } = {},
): HandlerContext => ({
  familyId: FAMILY,
  parentUserId: PARENT,
  conversationId: '33333333-3333-4333-8333-333333333333',
  body,
  send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' }),
  now: new Date('2026-07-30T12:00:00.000Z'),
  resolved: options.resolved ?? null,
  openQuestions: async () => options.open ?? [],
  inboundChannelMessageId: INBOUND_MESSAGE_ID,
});

/**
 * The pre-open branch, wired to readers that THROW.
 *
 * Every case that predates VIL-338 runs with F14 dark for this family, so the branch
 * returns before it reads anything — and this is the positive proof of that, rather
 * than a stub that would let a widened gate pass unnoticed.
 */
const NO_PREPARE: PrepareReplyDeps = {
  loadPreparingSequence: async () => {
    throw new Error('the pre-open branch must not run for a dark household');
  },
  readinessAskedLastAt: async () => {
    throw new Error('the pre-open branch must not run for a dark household');
  },
  fetchBody: async () => {
    throw new Error('the pre-open branch must not fetch');
  },
  recordCourseBinding: async () => {
    throw new Error('the pre-open branch must not write');
  },
  recordReadinessState: async () => {
    throw new Error('the pre-open branch must not write');
  },
};

const APPROVAL_QUESTION: OpenQuestion = {
  id: 'action-1',
  kind: 'approval',
  description: 'Add to your calendar',
  subject: 'add to your calendar',
  answerable: { yes: true, no: true },
  askedAt: null,
  solicited: false,
};

const INTRO_QUESTION: OpenQuestion = {
  id: 'proposal-1',
  kind: 'intro_proposal',
  description: 'Whether to meet one nearby Hale family',
  subject: 'meeting the family nearby',
  answerable: { yes: true, no: true },
  askedAt: null,
  solicited: false,
};

function spine(pending: PendingAction[]): ApprovalSpine & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    listPending: async () => pending,
    latestUndoable: async () => null,
    approve: async (_db, a) => {
      approved.push(a.actionId);
      return { ok: true };
    },
    decline: async () => ({ ok: true }),
    undo: async () => ({ ok: true }),
  };
}

/**
 * The offer the nudge WOULD have registered for this ref — production's own rule, which
 * is `checkpoint.booking` and nothing else (lib/health/offer.ts). A paperwork checkpoint
 * offers nothing, so a "yes" after one has nothing to accept.
 */
function offerFrom(ref: string | null): OpenCheckupOffer | null {
  const parsed = ref === null ? null : parseCheckpointRef(ref);
  const checkpoint = parsed ? checkpointById(parsed.checkpointId) : null;
  if (!checkpoint?.booking) return null;
  return {
    id: 'commitment-1',
    checkpoint,
    childId: parsed?.childId ?? null,
    summary: 'Whether to put booking this on your week',
    askedAt: new Date('2026-08-20T14:00:00.000Z'),
  };
}

/**
 * M8's deps, scripted: `ref` is the checkpoint the family was last nudged about, and
 * `offer` is the standing booking offer the nudge registered when it sent.
 */
function healthDeps(
  ref: string | null,
  offer: OpenCheckupOffer | null = offerFrom(ref),
): HealthReplyDeps & { done: string[]; drafted: string[]; closed: string[] } {
  const done: string[] = [];
  const drafted: string[] = [];
  const closed: string[] = [];
  return {
    done,
    drafted,
    closed,
    loadLastCheckpointRef: async () =>
      ref === null ? null : { ref, toldAt: new Date('2026-07-30T12:00:00.000Z') },
    loadOpenOffer: async () => offer,
    recordDone: async (_db, input) => {
      done.push(input.checkpointId);
    },
    draftCheckup: async (_db, input) => {
      drafted.push(input.intentKind);
      return { actionId: 'drafted-1' };
    },
    fulfillOffer: async (_db, input) => {
      closed.push(input.channelMessageId ?? 'none');
      return { status: 'closed', commitmentIds: ['commitment-1'] };
    },
  };
}

/** A real checkpoint ref, so M8's own parser accepts it. */
const CHILD = '44444444-4444-4444-8444-444444444444';
/** A real ref (`checkpointId:scope:occurrence`) whose task is NOT a booking. */
const PAPERWORK_CHECKPOINT = `dental_school_screening:${CHILD}:1`;
/** A real ref whose task IS booking a visit — the only kind that may offer a draft. */
const BOOKING_CHECKPOINT = `well_baby_18_months:${CHILD}:1`;

describe('approvalHandler', () => {
  it('claims an approval and executes it through the spine', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }]);
    const verdict = await approvalHandler(s).handle(DB, turn('yes'));

    expect(verdict.claimed).toBe(true);
    expect(s.approved).toEqual(['a-1']);
  });

  it('does not claim ordinary conversation', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }]);
    const verdict = await approvalHandler(s).handle(DB, turn('move swim to Tuesday'));

    expect(verdict.claimed).toBe(false);
    expect(s.approved).toEqual([]);
  });

  /** The property the whole ordering rests on. */
  it('does not claim a bare yes when nothing is drafted', async () => {
    const s = spine([]);
    const verdict = await approvalHandler(s).handle(DB, turn('yes'));

    expect(verdict.claimed).toBe(false);
  });
});

describe('healthReplyHandler', () => {
  it('claims "done" and files it as handled — no model, no verification', async () => {
    const deps = healthDeps(PAPERWORK_CHECKPOINT);
    const verdict = await healthReplyHandler(deps).handle(DB, turn('done'));

    expect(verdict.claimed).toBe(true);
    expect(deps.done).toEqual(['dental_school_screening']);
  });

  it('does not claim "not done yet" — the substring trap', async () => {
    const deps = healthDeps(PAPERWORK_CHECKPOINT);
    const verdict = await healthReplyHandler(deps).handle(DB, turn('not done yet'));

    expect(verdict.claimed).toBe(false);
    expect(deps.done).toEqual([]);
  });

  it('does not claim anything when no checkpoint is open', async () => {
    const deps = healthDeps(null);
    expect((await healthReplyHandler(deps).handle(DB, turn('done'))).claimed).toBe(false);
  });

  /** Rule #4: a "yes" on a booking checkpoint DRAFTS, it never books. */
  it('drafts for approval rather than acting, and says so', async () => {
    const deps = healthDeps(BOOKING_CHECKPOINT);
    const verdict = await healthReplyHandler(deps).handle(DB, turn('yes'));

    expect(deps.drafted).toEqual(['book_checkup']);
    // The hold is stated in-thread (doctrine: never an app link), with honest
    // verbs: YES puts it on the week; the clinic call stays the parent's.
    expect(verdict.claimed && verdict.reply).toMatch(/reply YES/i);
    expect(verdict.claimed && verdict.reply).toMatch(/nothing's booked/i);
    expect(verdict.claimed && verdict.reply).not.toMatch(/https?:/);
  });
});

describe('who owns "yes"', () => {
  /**
   * With a drafted action waiting, the approval handler takes it: a draft is a question
   * Hale asked and is actively holding an answer for, and it is the only one of the two
   * that can be answered wrongly in a way the parent cannot see.
   */
  it('goes to the approval handler when an action is waiting', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }]);
    const health = healthDeps(BOOKING_CHECKPOINT);

    const first = await approvalHandler(s).handle(DB, turn('yes'));
    expect(first.claimed).toBe(true);
    expect(s.approved).toEqual(['a-1']);
    expect(health.drafted).toEqual([]);
  });

  /**
   * With nothing drafted — the overwhelmingly common case — the approval handler
   * declines and the health nudge's own offer gets its answer. This is why the order
   * cannot starve the handler behind it.
   */
  it('falls through to the health nudge when nothing is waiting', async () => {
    const s = spine([]);
    const health = healthDeps(BOOKING_CHECKPOINT);

    expect((await approvalHandler(s).handle(DB, turn('yes'))).claimed).toBe(false);
    expect((await healthReplyHandler(health).handle(DB, turn('yes'))).claimed).toBe(true);
    expect(health.drafted).toEqual(['book_checkup']);
  });
});

/**
 * M7's deps, scripted. `open` decides whether this family is inside a check-in window —
 * the lookup M7 does BEFORE it parses, and the thing that makes its claims conditional.
 */
function sequenceDeps(
  options: { open?: boolean; reaskedAt?: Date | null } = {},
): SequenceReplyDeps & {
  recorded: Array<{ outcome: string; position: number | null }>;
  reasks: number;
} {
  const recorded: Array<{ outcome: string; position: number | null }> = [];
  const reasks: { n: number } = { n: 0 };
  const sequence: AwaitingSequence = {
    sequenceId: 'seq-1',
    familyId: FAMILY,
    parentUserId: PARENT,
    state: {
      openAt: new Date('2026-07-29T11:00:00.000Z'),
      timeZone: 'America/Toronto',
      optIn: 'opted_in',
      outcome: null,
      waitlistStartedAt: null,
      waitlistResponseHours: 36,
      portal: null,
    },
    shortlist: {
      windowRef: {
        id: 'win-1',
        municipality: 'Markham',
        programDomain: 'swim',
        cycleLabel: 'Fall 2026',
      },
      cyclePhrase: 'Fall 2026 swim lessons',
      opensForFamilyAt: new Date('2026-07-29T11:00:00.000Z'),
      sourceUrl: 'https://example.invalid/register',
      isResidentWindow: true,
      residentPriorityDays: null,
      waitlistResponseHours: 36,
      fitNotes: [],
      ageApproximate: false,
    },
    reaskedAt: options.reaskedAt ?? null,
  };

  return {
    get recorded() {
      return recorded;
    },
    get reasks() {
      return reasks.n;
    },
    loadAwaitingSequence: async () => (options.open === false ? null : sequence),
    recordOutcome: async (_db, input) => {
      recorded.push({ outcome: input.outcome, position: input.position });
    },
    recordReask: async () => {
      reasks.n += 1;
    },
  } as SequenceReplyDeps & {
    recorded: Array<{ outcome: string; position: number | null }>;
    reasks: number;
  };
}

describe('sequenceReplyHandler', () => {
  it('claims a waitlist report and files the position', async () => {
    const deps = sequenceDeps();
    const verdict = await sequenceReplyHandler(deps, NO_PREPARE).handle(DB, turn('waitlisted #3'));

    expect(verdict.claimed).toBe(true);
    expect(deps.recorded).toEqual([{ outcome: 'waitlisted', position: 3 }]);
  });

  it('claims a got-in report', async () => {
    const deps = sequenceDeps();
    const verdict = await sequenceReplyHandler(deps, NO_PREPARE).handle(DB, turn("we're in"));

    expect(verdict.claimed).toBe(true);
    expect(deps.recorded).toEqual([{ outcome: 'registered', position: null }]);
  });

  it('claims nothing when no check-in window is open', async () => {
    const deps = sequenceDeps({ open: false });
    const verdict = await sequenceReplyHandler(deps, NO_PREPARE).handle(DB, turn('waitlisted #3'));

    expect(verdict.claimed).toBe(false);
    expect(deps.recorded).toEqual([]);
  });

  /**
   * VIL-221 · C2. An unreadable message is now the COACH's, per M7's own module note:
   * a parent who texts something the check-in grammar cannot read is far more likely to
   * be asking Hale something than to be reporting a registration outcome in words M7
   * does not know. The stamp is still spent inside M7 (it owns the window's
   * bookkeeping); what changed is that the menu no longer wins the message.
   */
  it('declines an unreadable message so the coach can answer it', async () => {
    const deps = sequenceDeps();
    const verdict = await sequenceReplyHandler(deps, NO_PREPARE).handle(DB, turn('what a morning'));

    expect(verdict.claimed).toBe(false);
  });

  it('still declines once the re-ask is spent', async () => {
    const deps = sequenceDeps({ reaskedAt: new Date('2026-07-30T09:00:00.000Z') });
    const verdict = await sequenceReplyHandler(deps, NO_PREPARE).handle(DB, turn('what a morning'));

    expect(verdict.claimed).toBe(false);
  });
});

/**
 * The three-way interactions. Each asserts the FIRST handler in the shipped order that
 * claims the message, with every other handler's state left untouched — which is what
 * the router's first-claim-wins loop actually does.
 */
describe('handler order — registration last', () => {
  /**
   * The collision the order exists to prevent: a parent filing OHIP paperwork during an
   * open registration window. M7 cannot read "done", so ahead of M8 it would answer with
   * the check-in menu and the paperwork would go unfiled.
   */
  it('gives "done" to the health handler even with an open registration window', async () => {
    const health = healthDeps(PAPERWORK_CHECKPOINT);
    const sequence = sequenceDeps();

    const healthVerdict = await healthReplyHandler(health).handle(DB, turn('done'));

    expect(healthVerdict.claimed).toBe(true);
    expect(health.done).toEqual(['dental_school_screening']);
    // Never consulted, so the family's one re-ask is still theirs to spend.
    expect(sequence.reasks).toBe(0);
  });

  /** A drafted action still wins a bare "yes" — the approval handler is unchanged. */
  it('gives a bare "yes" to the approval handler when an action is drafted', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }]);
    const sequence = sequenceDeps();

    expect((await approvalHandler(s).handle(DB, turn('yes'))).claimed).toBe(true);
    expect(s.approved).toEqual(['a-1']);
    expect(sequence.reasks).toBe(0);
  });

  /** With nothing drafted, the health nudge's own offer still gets its "yes" — the
   * registration re-ask does not reach it. */
  it('gives a bare "yes" to the health nudge before the registration re-ask', async () => {
    const s = spine([]);
    const health = healthDeps(BOOKING_CHECKPOINT);
    const sequence = sequenceDeps();

    expect((await approvalHandler(s).handle(DB, turn('yes'))).claimed).toBe(false);
    expect((await healthReplyHandler(health).handle(DB, turn('yes'))).claimed).toBe(true);
    expect(health.drafted).toEqual(['book_checkup']);
    expect(sequence.reasks).toBe(0);
  });

  /** And the registration report itself is unreadable to the two ahead of it, so it
   * reaches M7 untouched. */
  it('lets a waitlist report fall through the two handlers ahead of it', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }]);
    const health = healthDeps(PAPERWORK_CHECKPOINT);
    const sequence = sequenceDeps();

    expect((await approvalHandler(s).handle(DB, turn('waitlisted #3'))).claimed).toBe(false);
    expect((await healthReplyHandler(health).handle(DB, turn('waitlisted #3'))).claimed).toBe(
      false,
    );
    expect((await sequenceReplyHandler(sequence, NO_PREPARE).handle(DB, turn('waitlisted #3'))).claimed).toBe(
      true,
    );
    expect(sequence.recorded).toEqual([{ outcome: 'waitlisted', position: 3 }]);
  });
});

/**
 * The intro lane sits FIRST, so the pair of properties that lets it sit there safely is
 * pinned in both directions — the same treatment "yes" gets above.
 */
describe('the village intro lane and the lanes behind it', () => {
  const introDeps: VillageIntroReplyDeps = {
    recordDiscoverability: async () => {},
    discoverabilityStanding: async () => 'unanswered' as const,
    answerableProposal: async () => null,
    recordDecision: async () => {},
    cancelOpenProposals: async () => {},
  };

  it('does not swallow a bare yes - it stays the approval lane s to answer', async () => {
    expect((await villageIntroHandler(introDeps).handle(DB, turn('yes'))).claimed).toBe(false);
    const pending = spine([
      { actionId: 'act-1', actionType: 'book_checkup', reviewerApproved: true },
    ]);
    expect((await approvalHandler(pending).handle(DB, turn('yes'))).claimed).toBe(true);
    expect(pending.approved).toEqual(['act-1']);
  });

  it('and the approval lane would not have answered YES INTRO even if it ran first', async () => {
    const pending = spine([
      { actionId: 'act-1', actionType: 'book_checkup', reviewerApproved: true },
    ]);
    expect((await approvalHandler(pending).handle(DB, turn('YES INTRO'))).claimed).toBe(false);
    expect(pending.approved).toEqual([]);
    expect((await villageIntroHandler(introDeps).handle(DB, turn('YES INTRO'))).claimed).toBe(true);
  });
});

describe('recMorningHandler', () => {
  it('answers a Toronto swim clock question with the locked first-rec line', async () => {
    const verdict = await recMorningHandler().handle(
      DB,
      turn('When does Toronto swim registration open?'),
    );
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed || verdict.reply === null) return;
    const body = verdict.reply;
    expect(body).toBe(
      "Toronto rec and swim open 7:00 a.m. on your district morning: Sept 9 if you're catchment-only, Sept 15 or 16 otherwise. Sign in at toronto.ca/OnlineReg with the centre district, not your home address.",
    );
    expect(body.toLowerCase()).not.toContain('activeto');
    expect(body.toLowerCase()).not.toContain('unofficial');
    expect(body.toLowerCase()).not.toContain('efun');
    expect(body).not.toMatch(/I'm an AI/i);
    expect(body).not.toMatch(/https?:\/\//i);
  });

  it('answers a named Markham rec ask with the locked leftover, not Toronto', async () => {
    const verdict = await recMorningHandler().handle(DB, turn('Markham fall rec dates?'));
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed || verdict.reply === null) return;
    expect(verdict.reply).toBe(
      "Markham fall rec, swim, and winter-break camps already opened Aug 11. Winter isn't posted. I can watch leftovers and the waitlist.",
    );
    expect(verdict.reply).not.toContain('7:00');
    expect(verdict.reply).not.toMatch(/Sept?\s*15/i);
    expect(verdict.reply.toLowerCase()).not.toContain('activeto');
  });

  it('leaves waitlisted #3 and a watch ask for the handlers that own them', async () => {
    expect((await recMorningHandler().handle(DB, turn('waitlisted #3'))).claimed).toBe(false);
    expect(
      (
        await recMorningHandler().handle(
          DB,
          turn('can you watch swim registration for Milo this fall?'),
        )
      ).claimed,
    ).toBe(false);
  });
});

/**
 * The order production actually ships. The tests above drive each handler directly, so
 * without this one the whole ordering argument could hold while `defaultHandlers`
 * returned them in some other sequence.
 */
describe('the shipped order', () => {
  it('is village_intro, approval, email_capture, connector_link, founder_welcome, health, coach_plan, registration, rec_morning, name_capture', async () => {
    const { defaultHandlers } = await import('./wiring');
    expect(defaultHandlers().map((h) => h.name)).toEqual([
      'village_intro',
      'approval',
      'email_capture',
      // Claims only an explicit connect-verb + provider-noun pair — a shape no other
      // handler's vocabulary contains — so its position among the specific-word
      // handlers is free; what matters is only that it is ahead of the bare-word
      // name capture, like everything else that matches something specific.
      'connector_link',
      // Ahead of the three handlers that read a bare affirmative for a household's OWN
      // business: this is the only one whose wrong answer texts a different household.
      'founder_welcome',
      'health',
      'coach_plan',
      'registration',
      'rec_morning',
      'name_capture',
    ]);
  });

  /**
   * The name capture is LAST, and this pins it rather than trusting the array above to be
   * read carefully. It claims a bare word, which is the broadest shape in the chain, so
   * every handler that matches a SPECIFIC word has to get first refusal: "done" is a
   * health outcome and "we got in" is a registration result, and a family with an open
   * name ask must be able to answer one without being renamed for it.
   */
  it('puts the name capture behind every handler that matches a specific word', async () => {
    const { defaultHandlers } = await import('./wiring');
    const names = defaultHandlers().map((h) => h.name);
    expect(names.at(-1)).toBe('name_capture');
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('registration'));
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('rec_morning'));
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('health'));
  });

  /**
   * Three handlers now recognise a bare "yes", and this pins the tie-break rather than
   * leaving it to the array above being read the right way: among them, the one whose
   * WRONG answer costs most claims it first. A mis-fired approval executes a calendar
   * write; a mis-read health yes silences a records reminder for months; a mis-sent
   * plan is three texts of advice. So the plan lane is last of the three, and a parent
   * with a draft pending still means the draft when they type YES.
   */
  it('puts the plan lane behind both of the other yes-claimers', async () => {
    const { defaultHandlers } = await import('./wiring');
    const names = defaultHandlers().map((h) => h.name);

    expect(names.indexOf('coach_plan')).toBeGreaterThan(names.indexOf('approval'));
    expect(names.indexOf('coach_plan')).toBeGreaterThan(names.indexOf('health'));
  });
});

/**
 * THE AMBIGUOUS BARE AFFIRMATIVE (2026-08-13).
 *
 * The intro card used to end "Reply YES INTRO", and that two-word answer is the only
 * reason the approvals grammar could safely own every bare "yes". Composing the card
 * removed the disambiguator; these pin what replaced it.
 */
describe('a bare affirmative with more than one kind of question open', () => {
  const pending = [{ actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true }];

  it('does NOT approve a calendar change when an intro card is also waiting', async () => {
    // The defect this closes: the parent answered "Want me to introduce you?" and Hale
    // executed a calendar write they never confirmed (rule #4).
    const s = spine(pending);
    const verdict = await approvalHandler(s).handle(
      DB,
      turn('yes', { open: [APPROVAL_QUESTION, INTRO_QUESTION] }),
    );

    expect(verdict.claimed).toBe(false);
    expect(s.approved).toEqual([]);
  });

  it('still approves when the drafted change is the only thing waiting', async () => {
    const s = spine(pending);
    const verdict = await approvalHandler(s).handle(DB, turn('yes', { open: [APPROVAL_QUESTION] }));

    expect(verdict.claimed).toBe(true);
    expect(s.approved).toEqual(['a-1']);
  });

  it('still answers an ORDINAL, which cannot be an answer to anything else', async () => {
    // "yes 2" is not conversation and is not an intro answer. It never waits.
    const s = spine([
      { actionId: 'a-1', actionType: 'calendar_add', reviewerApproved: true },
      { actionId: 'a-2', actionType: 'reschedule_event', reviewerApproved: true },
    ]);
    const verdict = await approvalHandler(s).handle(
      DB,
      turn('yes 2', { open: [APPROVAL_QUESTION, INTRO_QUESTION] }),
    );

    expect(verdict.claimed).toBe(true);
    expect(s.approved).toEqual(['a-2']);
  });

  it('still answers UNDO, which names the last thing Hale did', async () => {
    const s = spine([]);
    const verdict = await approvalHandler(s).handle(
      DB,
      turn('undo', { open: [APPROVAL_QUESTION, INTRO_QUESTION] }),
    );
    expect(verdict.claimed).toBe(true);
  });

  it('holds the health nudge back too - its question is not even a yes/no one', async () => {
    const health = healthDeps(BOOKING_CHECKPOINT);
    const verdict = await healthReplyHandler(health).handle(
      DB,
      turn('yes', { open: [INTRO_QUESTION] }),
    );

    expect(verdict.claimed).toBe(false);
    expect(health.drafted).toEqual([]);
  });

  it('never holds back an EXACT word - "done" is not ambiguous', async () => {
    // Only the bare affirmative waits. The vocabulary each handler owns exactly is free
    // and instant, which is the whole reason it runs first.
    const health = healthDeps(PAPERWORK_CHECKPOINT);
    const verdict = await healthReplyHandler(health).handle(
      DB,
      turn('done', { open: [APPROVAL_QUESTION, INTRO_QUESTION] }),
    );

    expect(verdict.claimed).toBe(true);
  });
});

/**
 * VIL-338 · the PRE-OPEN branch on the same handler.
 *
 * M7's handler answered the morning after; it now also answers the days before, and the
 * two shapes it can claim there are a pasted course link and a bare YES/NO to the
 * readiness checklist. Everything below pins WHO GETS THE MESSAGE, which is the only
 * contested decision — the writes themselves are proven against Postgres in
 * registration/sequence/prepare-reply.test.ts.
 */

const FIXTURE_PAGE = readFileSync(
  join(__dirname, '..', 'spots', 'fixtures', 'open-window-open-markham.html'),
  'utf8',
);

const MARKHAM_PORTAL: SpotPortal = {
  portalLabel: "Markham's portal",
  municipality: 'markham',
  timeZone: 'America/Toronto',
  accountLabel: 'a Markham portal account',
};

const LEGO_URL =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928';

const PREPARING: PreparingSequence = {
  sequenceId: 'seq-1',
  familyId: FAMILY,
  parentUserId: PARENT,
  windowId: 'win-1',
  municipality: 'markham',
  portal: MARKHAM_PORTAL,
  opensForFamilyAt: new Date('2026-08-11T06:30:00-04:00'),
  isResidentWindow: true,
  timeZone: 'America/Toronto',
  courseUrl: null,
  courseOpensAt: null,
  readinessReady: null,
  fitNotes: [{ childId: 'child-1', name: 'Mia', fit: 'in_band' }],
  children: [{ id: 'child-1', dateOfBirth: '2021-08-01', dobPrecision: 'exact' }],
};

const READINESS_QUESTION: OpenQuestion = {
  id: 'seq-1',
  kind: 'registration_readiness',
  description: 'Whether the setup on Markham’s portal is done',
  subject: 'getting set up for the registration morning',
  answerable: { yes: true, no: true },
  askedAt: new Date('2026-08-04T14:00:00.000Z'),
  solicited: true,
};

const PRE_OPEN_NOW = new Date('2026-08-04T12:00:00.000Z');

function prepareDeps(
  options: {
    sequence?: PreparingSequence | null;
    askedAt?: Date | null;
    page?: string | null;
  } = {},
) {
  const bound: Array<{ url: string; courseOpensAt: Date; inbound: string }> = [];
  const readiness: Array<{ ready: boolean; inbound: string; read: string }> = [];
  return {
    bound,
    readiness,
    loadPreparingSequence: async () =>
      options.sequence === undefined ? PREPARING : options.sequence,
    readinessAskedLastAt: async () =>
      options.askedAt === undefined ? READINESS_QUESTION.askedAt : options.askedAt,
    fetchBody: async () => {
      if (options.page === null) throw new Error('ETIMEDOUT');
      return options.page ?? FIXTURE_PAGE;
    },
    recordCourseBinding: async (_db, input) => {
      bound.push({
        url: input.url,
        courseOpensAt: input.courseOpensAt,
        inbound: input.inboundChannelMessageId,
      });
      return 'bound' as const;
    },
    recordReadinessState: async (_db, input) => {
      readiness.push({
        ready: input.ready,
        inbound: input.inboundChannelMessageId,
        read: input.read,
      });
      return 'recorded' as const;
    },
  } satisfies PrepareReplyDeps & {
    bound: Array<{ url: string; courseOpensAt: Date; inbound: string }>;
    readiness: Array<{ ready: boolean; inbound: string; read: string }>;
  };
}

/** The pre-open branch only runs for a household F14 is armed for (D21). */
function preOpenTurn(
  body: string,
  options: { resolved?: ResolvedAnswer | null; open?: OpenQuestion[] } = {},
): HandlerContext {
  return { ...turn(body, options), now: PRE_OPEN_NOW };
}

describe('sequenceReplyHandler · the pre-open branch', () => {
  beforeEach(() => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', FAMILY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('binds a pasted course link and answers with the ack', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`here you go ${LEGO_URL}`),
    );

    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.outcome).toBe('bound');
    expect(verdict.reply).toContain("Markham's portal");
    expect(prepare.bound).toEqual([
      {
        url: LEGO_URL,
        courseOpensAt: new Date('2026-08-11T06:30:00-04:00'),
        inbound: INBOUND_MESSAGE_ID,
      },
    ]);
  });

  /**
   * The collision with VIL-337. A course whose registration is already open is what the
   * watch verb and the coach are for; a refusal here would be Hale saying it cannot do
   * the thing it can actually do.
   */
  it('declines an already-registering course so the coach gets the turn', async () => {
    const prepare = prepareDeps({
      sequence: { ...PREPARING, opensForFamilyAt: new Date('2026-08-20T10:30:00.000Z') },
    });
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      { ...preOpenTurn(LEGO_URL), now: new Date('2026-08-11T06:45:00-04:00') },
    );

    expect(verdict.claimed).toBe(false);
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
  });

  it('records a bare YES when readiness is the only thing open', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yes', { open: [READINESS_QUESTION] }),
    );

    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.outcome).toBe('readiness_recorded');
    expect(prepare.readiness).toEqual([
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'keyword' },
    ]);
  });

  it('records a bare NO — a no is a fact this feature keeps', async () => {
    const prepare = prepareDeps();
    await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('no', { open: [READINESS_QUESTION] }),
    );

    expect(prepare.readiness).toEqual([
      { ready: false, inbound: INBOUND_MESSAGE_ID, read: 'keyword' },
    ]);
  });

  it('claims nothing when a drafted action is open too — nobody gets an ambiguous yes', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yes', { open: [READINESS_QUESTION, APPROVAL_QUESTION] }),
    );

    expect(verdict.claimed).toBe(false);
    expect(prepare.readiness).toEqual([]);
  });

  /**
   * THE VACUOUS-TRUTH GUARD. An empty open-question list is unambiguous by definition,
   * so `soleOpenKind` alone would let ANY bare yes into this writer the moment a family
   * had an opted-in pre-open sequence — including one answering the coach's own prose
   * question, which is never a listed kind. The ask row is what makes the claim real.
   */
  it('claims nothing when no ask has gone out, even with an opted-in pre-open sequence', async () => {
    const prepare = prepareDeps({ askedAt: null });
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yes'),
    );

    expect(verdict.claimed).toBe(false);
    expect(prepare.readiness).toEqual([]);
  });

  it('records both when the link and the answer arrive in one message, and acks the bind', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`yes ${LEGO_URL}`, { open: [READINESS_QUESTION] }),
    );

    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(prepare.bound).toHaveLength(1);
    expect(prepare.readiness).toEqual([
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'keyword' },
    ]);
    // ONE ack, and it is the bind's: two receipts for one message is two messages.
    expect(verdict.reply).toContain("Markham's portal");
    expect(verdict.outcome).toBe('bound');
  });

  /**
   * THE RIDING WORD IS STILL A BARE WORD. A parent who answers the coach's own prose
   * question ("send me the link?") with "yes <url>" is doing ONE thing — pasting a
   * link. Filing a readiness fact off that word would attribute to the parent the one
   * sentence this feature promises to attribute honestly, so the alongside write needs
   * the SAME two permissions the bare word needs: Hale's ask has to be its last word,
   * and no other open question could have meant the yes.
   */
  it('binds and ignores the riding YES when no readiness ask has gone out', async () => {
    const prepare = prepareDeps({ askedAt: null });
    // An EMPTY open-question list, which is vacuously unambiguous — so the ask row is
    // the only permission that can refuse this word, and it is what the case measures.
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`yes ${LEGO_URL}`),
    );

    // Kills a riding-YES path that skips `readinessAskedLastAt`.
    expect(verdict.claimed).toBe(true);
    expect(prepare.bound).toHaveLength(1);
    expect(prepare.readiness).toEqual([]);
  });

  it('binds and ignores the riding YES while another question could have meant it', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`yes ${LEGO_URL}`, { open: [READINESS_QUESTION, APPROVAL_QUESTION] }),
    );

    // Kills a riding-YES path that skips `mayClaimBareWord`.
    expect(verdict.claimed).toBe(true);
    expect(prepare.bound).toHaveLength(1);
    expect(prepare.readiness).toEqual([]);
  });

  it('files nothing off the riding YES when the link itself was refused', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`yes ${LEGO_URL.replace('https://', 'http://')}`, {
        open: [READINESS_QUESTION],
      }),
    );

    // Kills dropping `bind.status !== 'refused'` from the alongside guard: a paste Hale
    // refused is a turn the parent has to repeat, not a checklist they answered.
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.outcome).toBe('refused');
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
  });

  /**
   * The router finds the second-pass owner by `handler.resolves?.has(reading.kind)`
   * (route.ts). With this set emptied every resolver-read hedged answer is dropped on
   * the floor and the second-pass cases above still pass, because they set
   * `ctx.resolved` directly and never go through that lookup.
   */
  it('declares the kind it owns, which is how the router finds it on the second pass', () => {
    expect(sequenceReplyHandler(sequenceDeps(), NO_PREPARE).resolves).toEqual(
      new Set(['registration_readiness']),
    );
  });

  it('takes the resolver’s own reading on the second pass', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yeah I think so', {
        resolved: {
          kind: 'registration_readiness',
          questionId: 'seq-1',
          polarity: 'yes',
          confidence: 'medium',
        },
      }),
    );

    expect(verdict.claimed).toBe(true);
    expect(prepare.readiness).toEqual([
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'resolver' },
    ]);
  });

  it('takes the resolver’s NO as a no — kills a resolver path that ignores polarity', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('nah not yet', {
        resolved: {
          kind: 'registration_readiness',
          questionId: 'seq-1',
          polarity: 'no',
          confidence: 'medium',
        },
      }),
    );

    expect(verdict.claimed).toBe(true);
    expect(prepare.readiness).toEqual([
      { ready: false, inbound: INBOUND_MESSAGE_ID, read: 'resolver' },
    ]);
  });

  /**
   * THE PROVENANCE GUARD. Every fact this branch files points at the `channel_messages`
   * row that carried it (rule #6), and a spoken turn has none. Unreachable today — no
   * kind this handler resolves is in `SPOKEN_QUESTION_KINDS` — which is exactly the
   * shape of guard that rots unwatched, so it is pinned rather than trusted.
   */
  it('claims nothing when the turn carries no inbound message row — kills invented provenance', async () => {
    const prepare = prepareDeps();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(DB, {
      ...preOpenTurn(LEGO_URL),
      inboundChannelMessageId: null,
    });

    expect(verdict.claimed).toBe(false);
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('is inert while F14 is dark for this household (D21)', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
    const prepare = prepareDeps();

    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(LEGO_URL),
    );

    expect(verdict.claimed).toBe(false);
    expect(prepare.bound).toEqual([]);
  });

  /**
   * THE INERTNESS PROOF for the thirteen municipalities with no portal: the loader
   * returns null and the handler behaves exactly as it did before this branch existed.
   */
  it('is byte-identical to today for a municipality with no portal', async () => {
    const prepare = prepareDeps({ sequence: null });
    const sequence = sequenceDeps();

    const bare = await sequenceReplyHandler(sequence, prepare).handle(
      DB,
      turn('yes', { open: [READINESS_QUESTION] }),
    );
    const report = await sequenceReplyHandler(sequence, prepare).handle(
      DB,
      turn('waitlisted #3'),
    );

    expect(bare.claimed).toBe(false);
    expect(report.claimed).toBe(true);
    expect(sequence.recorded).toEqual([{ outcome: 'waitlisted', position: 3 }]);
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
  });

  it('leaves the three check-in certainties to the post-open path untouched', async () => {
    const prepare = prepareDeps();
    const sequence = sequenceDeps();

    for (const body of ['waitlisted #3', "we're in", 'missed it']) {
      expect(
        (await sequenceReplyHandler(sequence, prepare).handle(DB, turn(body))).claimed,
      ).toBe(true);
    }
    expect(sequence.recorded.map((row) => row.outcome)).toEqual([
      'waitlisted',
      'registered',
      'missed',
    ]);
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
  });
});
