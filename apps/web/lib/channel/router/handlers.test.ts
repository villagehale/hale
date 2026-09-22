import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CanaryHousehold, canaryChannel } from '~/lib/channel/canary/config';
import { seedCanaryHousehold } from '~/lib/channel/canary/seed';
import { cityRecLine } from '~/lib/channel/rec-morning';
import type { SpotPortal } from '~/lib/channel/spots/url';
import { checkpointById, parseCheckpointRef } from '~/lib/health/checkpoints';
import type { OpenCheckupOffer } from '~/lib/health/offer';
import type { HealthReplyDeps } from '~/lib/health/reply';
import { SHORTLIST_ALREADY_APPROVED_ACK } from '~/lib/registration/sequence/copy';
import type {
  BindReadClaimResult,
  PrepareReplyDeps,
  PreparingSequence,
} from '~/lib/registration/sequence/prepare-reply';
import type { AwaitingSequence, SequenceReplyDeps } from '~/lib/registration/sequence/reply';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
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
/** The clock every handler in this spec is driven at. Named because the rec-morning
 * lane answers from the registration dataset AS OF this instant. */
const TURN_NOW = new Date('2026-07-30T12:00:00.000Z');

const turn = (
  body: string,
  options: { resolved?: ResolvedAnswer | null; open?: OpenQuestion[] } = {},
): HandlerContext => ({
  familyId: FAMILY,
  parentUserId: PARENT,
  conversationId: '33333333-3333-4333-8333-333333333333',
  body,
  send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' }),
  now: TURN_NOW,
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
  approvedShortlistAskedOf: async () => {
    throw new Error('the pre-open branch must not run for a dark household');
  },
  claimBindRead: async () => {
    throw new Error('the pre-open branch must not claim a read');
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

/** "How did Mia get on at swim?" — Hale waiting to hear back, answerable in neither
 * polarity and listed for exactly that reason (channel/followup/ask-open.ts). */
const ACTIVITY_ASK_QUESTION: OpenQuestion = {
  id: 'message-1',
  kind: 'activity_followup_ask',
  description: 'How an activity went',
  subject: 'how that activity went',
  answerable: { yes: false, no: false },
  askedAt: new Date('2026-07-30T00:30:00.000Z'),
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
    expect(
      (await sequenceReplyHandler(sequence, NO_PREPARE).handle(DB, turn('waitlisted #3'))).claimed,
    ).toBe(true);
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
  it("answers a Toronto swim clock question with the dataset's Toronto dates", async () => {
    const verdict = await recMorningHandler().handle(
      DB,
      turn('When does Toronto swim registration open?'),
    );
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed || verdict.reply === null) return;
    const body = verdict.reply;
    expect(body).toBe(cityRecLine('toronto', TURN_NOW));
    expect(body).toContain('residents Tuesday Sep 15 at 7 a.m.');
    expect(body).toContain('toronto.ca/OnlineReg');
    expect(body.toLowerCase()).not.toContain('activeto');
    expect(body.toLowerCase()).not.toContain('unofficial');
    expect(body.toLowerCase()).not.toContain('efun');
    expect(body).not.toMatch(/I'm an AI/i);
    expect(body).not.toMatch(/https?:\/\//i);
  });

  it("answers a named Markham rec ask with Markham's own cycle, not Toronto", async () => {
    const verdict = await recMorningHandler().handle(DB, turn('Markham fall rec dates?'));
    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed || verdict.reply === null) return;
    expect(verdict.reply).toBe(cityRecLine('markham', TURN_NOW));
    expect(verdict.reply).toContain('Tuesday Aug 11 at 6:30 a.m.');
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
  it('is village_intro, approval, email_capture, connector_link, connector_disconnect, forward_address, founder_welcome, co_parent_assent, weekday_care, daycare_followup, health, email_alert_add, coach_plan, registration, rec_morning, parent_call_name, name_capture, evening_check_in, inbound_canary', async () => {
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
      // The undo, beside the door it undoes. Its position is free for the same reason
      // the link's is — the two matchers are disjoint by construction (detect.ts), and
      // neither shape is in any other handler's vocabulary. It reads no bare word, so
      // it can never take a turn a YES belongs to.
      'connector_disconnect',
      // The forwarding address, beside the pair it reads like. Free for their reason:
      // all three matchers require a noun no other handler's vocabulary contains, and
      // each half asserts its disjointness from the others over its whole phrase table.
      // It reads no bare word either, so no YES can land here.
      'forward_address',
      // Ahead of the three handlers that read a bare affirmative for a household's OWN
      // business: this is the only one whose wrong answer texts a different household.
      'founder_welcome',
      // Owns the co-parent scope question and DECLINES every reading of it (VIL-355):
      // the answer is read by keyword one lane earlier, because a model deciding it
      // heard a yes here is a cold text to a stranger. Its position is free — it claims
      // nothing — but it is listed so the resolver never finds a kind without an owner.
      'co_parent_assent',
      // Beside it, and for the same reason: it owns the weekday-care question
      // (VIL-360) and declines every reading of it, because the answer is an either/or
      // in ordinary English that a deterministic grammar reads one gate later. Its
      // position is free - it claims nothing - and it is listed so the resolver never
      // finds a kind without an owner.
      'weekday_care',
      // Its sibling, and the same note applies: it owns the daycare check-in's kind
      // (VIL-360), claims nothing, and is listed only so the resolver never finds a
      // kind without an owner.
      'daycare_followup',
      'health',
      // Between health and the plan, by this chain's own rule: among handlers that read
      // the same bare word, the one whose wrong answer costs most goes first. A wrong
      // reading here writes a real entry on the week and materializes reminders off it —
      // more than three texts of advice, less than filing a health checkpoint as handled.
      'email_alert_add',
      'coach_plan',
      'registration',
      'rec_morning',
      // Immediately before the bare-word capture, so "yes" to "Can I call you Bea?"
      // is the confirm and not a name, while "Bea" answering the open ask still
      // falls through to the capture.
      'parent_call_name',
      'name_capture',
      // Behind even the bare-word capture, because it is the one handler that claims a
      // whole SENTENCE rather than a shape (VIL-353). Ahead of it, a parent's "done" or
      // "yes" would be filed as a diary entry instead of reaching the lane that owns it.
      'evening_check_in',
      // Behind even the bare-word capture, and that is the mechanism rather
      // than a tidy tail: the canary turn is worth its rows only if it runs
      // every other handler's DECLINE path first — including the registration
      // reader, which is where every turn actually crashed (#617).
      'inbound_canary',
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
    expect(names.at(-1)).toBe('inbound_canary');
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('registration'));
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('rec_morning'));
    expect(names.indexOf('name_capture')).toBeGreaterThan(names.indexOf('health'));
    expect(names.indexOf('parent_call_name')).toBe(names.indexOf('name_capture') - 1);
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

  it('does NOT approve a calendar change while Hale is waiting to hear how swim went', async () => {
    // The theft this closed: the ask was not a listed question, so one drafted approval
    // made every open question an approval and the parent's "yes" — said to "How did Mia
    // get on at swim?" — executed the calendar write (rule #4).
    const s = spine(pending);
    const verdict = await approvalHandler(s).handle(
      DB,
      turn('yes', { open: [APPROVAL_QUESTION, ACTIVITY_ASK_QUESTION] }),
    );

    expect(verdict.claimed).toBe(false);
    expect(s.approved).toEqual([]);
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
    claim?: BindReadClaimResult;
    /** The household's already-approved shortlist, while its ask is still this
     * parent's last word — null (the default) is every household but that one. */
    approved?: { sequenceId: string } | null;
  } = {},
) {
  const bound: Array<{ url: string; courseOpensAt: Date; inbound: string }> = [];
  const readiness: Array<{ ready: boolean; inbound: string; read: string; actor: string }> = [];
  return {
    bound,
    readiness,
    loadPreparingSequence: async () =>
      options.sequence === undefined ? PREPARING : options.sequence,
    readinessAskedLastAt: async () =>
      options.askedAt === undefined ? READINESS_QUESTION.askedAt : options.askedAt,
    approvedShortlistAskedOf: async () => options.approved ?? null,
    claimBindRead: async () => options.claim ?? { status: 'claimed' as const },
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
        // WHO the answer is filed under. The ladder asks both parents, so this is the
        // turn's own parent and never the seat that claimed the window (rule #6).
        actor: input.parentUserId,
      });
      return 'recorded' as const;
    },
  } satisfies PrepareReplyDeps & {
    bound: Array<{ url: string; courseOpensAt: Date; inbound: string }>;
    readiness: Array<{ ready: boolean; inbound: string; read: string; actor: string }>;
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
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(DB, {
      ...preOpenTurn(LEGO_URL),
      now: new Date('2026-08-11T06:45:00-04:00'),
    });

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
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'keyword', actor: PARENT },
    ]);
  });

  it('records a bare NO — a no is a fact this feature keeps', async () => {
    const prepare = prepareDeps();
    await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('no', { open: [READINESS_QUESTION] }),
    );

    expect(prepare.readiness).toEqual([
      { ready: false, inbound: INBOUND_MESSAGE_ID, read: 'keyword', actor: PARENT },
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
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'keyword', actor: PARENT },
    ]);
    // ONE ack, and it is the bind's: two receipts for one message is two messages.
    expect(verdict.reply).toContain("Markham's portal");
    expect(verdict.outcome).toBe('bound');
  });

  /**
   * Structural today — a turn with no link never reaches the bind at all — so this is
   * the guard ON that structure. Kills hoisting the read claim into `preOpenReply` or
   * the handler above the LINK_TOKEN branch, where a bare YES would spend a household's
   * read on a message that asked no municipality anything.
   */
  it('never touches the read claim on a turn that carries no link', async () => {
    const prepare = prepareDeps();
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), {
      ...prepare,
      claimBindRead: async () => {
        throw new Error('a turn with no link must not claim a read');
      },
    }).handle(DB, preOpenTurn('yes', { open: [READINESS_QUESTION] }));

    expect(verdict.claimed).toBe(true);
    expect(prepare.readiness).toEqual([
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'keyword', actor: PARENT },
    ]);
  });

  /**
   * Kills `bind.status !== 'refused'` — a NEGATIVE check that silently admits every
   * status added after it. A throttled turn files the parent's portal setup as a stated
   * fact against a message whose reply says Hale never opened their link: two receipts
   * for one text, and one of them contradicting the other.
   */
  it('does not file the riding YES when the link was never read', async () => {
    const prepare = prepareDeps({ claim: { status: 'throttled', retryMinutes: 7 } });
    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn(`yes ${LEGO_URL}`, { open: [READINESS_QUESTION] }),
    );

    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.outcome).toBe('read_throttled');
    expect(verdict.reply).toContain('in 7 minutes');
    expect(prepare.bound).toEqual([]);
    expect(prepare.readiness).toEqual([]);
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
      { ready: true, inbound: INBOUND_MESSAGE_ID, read: 'resolver', actor: PARENT },
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
      { ready: false, inbound: INBOUND_MESSAGE_ID, read: 'resolver', actor: PARENT },
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
    const report = await sequenceReplyHandler(sequence, prepare).handle(DB, turn('waitlisted #3'));

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
      expect((await sequenceReplyHandler(sequence, prepare).handle(DB, turn(body))).claimed).toBe(
        true,
      );
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

/**
 * THE SECOND PARENT'S YES — the heads-up asks both numbers, and one household action
 * answers both (audit 2026-09-17 r1).
 *
 * The first YES empties the approvals queue, so the second reaches this handler with
 * nothing pending anywhere ahead of it. What it must NOT do is fall through to a coach
 * whose thread with this parent still ends in "Reply YES and I'll run the morning with
 * you" and which knows nothing about their partner's answer.
 */
describe('sequenceReplyHandler · a yes to a card the household already approved', () => {
  beforeEach(() => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', FAMILY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The pre-open branch declines this turn — no readiness ask has reached THIS parent
   * — which is exactly the state the second parent is in. */
  const secondParent = (options: { approved?: { sequenceId: string } | null } = {}) =>
    prepareDeps({
      askedAt: null,
      approved: options.approved === undefined ? { sequenceId: 'seq-1' } : options.approved,
    });

  it('answers it with the household’s state instead of handing it to the coach', async () => {
    const prepare = secondParent();

    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yes'),
    );

    expect(verdict.claimed).toBe(true);
    if (!verdict.claimed) throw new Error('unreachable');
    expect(verdict.outcome).toBe('already_approved');
    expect(verdict.reply).toBe(SHORTLIST_ALREADY_APPROVED_ACK);
    // It acted on nothing: no second approval, no readiness fact invented out of a
    // word that was answering the card.
    expect(prepare.readiness).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL. Same turn, same handler, no approved shortlist behind it —
   * the ordinary bare "yes" that has always belonged to the coach. Without this the
   * reader could be deleted and the case above would be the only thing that noticed.
   */
  it('leaves an ordinary bare yes alone', async () => {
    const prepare = secondParent({ approved: null });

    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), prepare).handle(
      DB,
      preOpenTurn('yes'),
    );

    expect(verdict.claimed).toBe(false);
  });

  /** A NO is a household disagreeing with itself. That is a conversation — possibly an
   * undo — and a cheerful receipt would be the worst answer available. */
  it('never answers a NO', async () => {
    const verdict = await sequenceReplyHandler(
      sequenceDeps({ open: false }),
      secondParent(),
    ).handle(DB, preOpenTurn('no'));

    expect(verdict.claimed).toBe(false);
  });

  /** Something else is open, so the word is ambiguous and the resolver gets the turn —
   * the same permission every bare affirmative in this chain needs. */
  it('declines while another question is open', async () => {
    const verdict = await sequenceReplyHandler(
      sequenceDeps({ open: false }),
      secondParent(),
    ).handle(DB, preOpenTurn('yes', { open: [APPROVAL_QUESTION, READINESS_QUESTION] }));

    expect(verdict.claimed).toBe(false);
  });

  it('is inert while F14 is dark for this household (D21)', async () => {
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');

    const verdict = await sequenceReplyHandler(sequenceDeps({ open: false }), {
      ...secondParent(),
      approvedShortlistAskedOf: async () => {
        throw new Error('a dark household must not be read');
      },
    }).handle(DB, turn('yes'));

    expect(verdict.claimed).toBe(false);
  });
});

/**
 * THE CANARY REACHES THE CRASH SITE (#617/#622).
 *
 * The write-side canary is only evidence if its turn walks the code a real
 * turn walks. What broke on the night this exists for was inside the EIGHTH
 * handler's reader — `loadAwaitingSequence`, whose bound Date threw at
 * serialization before the statement was sent, for any family at all. So the
 * claim being pinned here is not "the canary handler works"; it is "nothing
 * ahead of it claims, and a throw anywhere in front of it takes the job down".
 */
describe('the canary turn walks the whole chain', () => {
  const CANARY_KEY = Buffer.alloc(32, 9).toString('base64');
  let canaryDb: TestDb;
  let household: CanaryHousehold;

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = CANARY_KEY;
    canaryDb = await createTestDb();
    // The REAL seed script's household, not a stand-in: this test is the evidence
    // that the probe reaches the #617 crash site, and a hand-rolled family with an
    // email and a province is not the family production will have (seed.ts writes
    // neither). Resolved back through the identity path the door uses.
    await seedCanaryHousehold(canaryDb.database);
    const resolved = await canaryChannel(canaryDb.database);
    if (!resolved) throw new Error('the seeded canary household did not resolve');
    household = resolved;
  }, 120_000);

  afterAll(async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    await canaryDb.close();
  });

  function canaryTurn(): HandlerContext {
    return {
      familyId: household.familyId,
      parentUserId: household.parentUserId,
      conversationId: '77777777-7777-4777-8777-777777777777',
      body: 'CANARY',
      now: new Date(),
      send: async () => {
        throw new Error('the canary answers for itself — it must never send');
      },
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: INBOUND_MESSAGE_ID,
    };
  }

  it('is declined by all ten handlers ahead of it, and claimed by the eleventh', async () => {
    const { defaultHandlers } = await import('./wiring');
    const chain = defaultHandlers();

    const verdicts: boolean[] = [];
    for (const handler of chain) {
      const verdict = await handler.handle(canaryDb.database, canaryTurn());
      verdicts.push(verdict.claimed);
      if (verdict.claimed) break;
    }

    expect(verdicts.slice(0, -1).every((claimed) => claimed === false)).toBe(true);
    expect(verdicts).toHaveLength(chain.length);
    expect(chain[verdicts.length - 1]?.name).toBe('inbound_canary');
  });

  it('would have gone red on the night the registration reader threw', async () => {
    const { defaultHandlers } = await import('./wiring');
    const chain = defaultHandlers();

    // The #617 shape at the seam it really happened at: the DRIVER refuses the
    // registration read before the statement is sent. Injected at the driver
    // rather than at a module boundary because the throw was a serialization
    // failure inside the driver, and a mocked reader could never show it.
    vi.spyOn(canaryDb.client, 'query').mockImplementation((async (
      sql: string,
      ...rest: unknown[]
    ) => {
      if (typeof sql === 'string' && sql.includes('registration_sequences')) {
        throw new TypeError('ERR_INVALID_ARG_TYPE');
      }
      return (
        Object.getPrototypeOf(canaryDb.client) as { query: (...args: unknown[]) => unknown }
      ).query.call(canaryDb.client, sql, ...rest);
    }) as never);

    const walk = async () => {
      for (const handler of chain) {
        const verdict = await handler.handle(canaryDb.database, canaryTurn());
        if (verdict.claimed) return handler.name;
      }
      return null;
    };

    // No handler ever claims: the job throws, pg-boss leaves the row in
    // `retry`, and the lane reads stale ten minutes later.
    await expect(walk()).rejects.toThrow('ERR_INVALID_ARG_TYPE');
    vi.restoreAllMocks();
  });
});
