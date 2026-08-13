import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { HealthReplyDeps } from '~/lib/health/reply';
import type { ApprovalSpine, PendingAction } from './approval';
import type { AwaitingSequence, SequenceReplyDeps } from '~/lib/registration/sequence/reply';
import type { VillageIntroReplyDeps } from '~/lib/village/intros/reply';
import {
  approvalHandler,
  healthReplyHandler,
  sequenceReplyHandler,
  villageIntroHandler,
} from './handlers';
import type { HandlerContext } from './route';

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

const turn = (body: string): HandlerContext => ({
  familyId: FAMILY,
  parentUserId: PARENT,
  conversationId: '33333333-3333-4333-8333-333333333333',
  body,
  now: new Date('2026-07-30T12:00:00.000Z'),
});

function spine(pending: PendingAction[]): ApprovalSpine & { approved: string[] } {
  const approved: string[] = [];
  return {
    approved,
    listPending: async () => pending,
    latestUndoable: async () => null,
    approve: async (_db, a) => {
      approved.push(a.actionId);
      return true;
    },
    decline: async () => true,
    undo: async () => true,
  };
}

/** M8's deps, scripted: `ref` is the checkpoint the family was last nudged about. */
function healthDeps(ref: string | null): HealthReplyDeps & { done: string[]; drafted: string[] } {
  const done: string[] = [];
  const drafted: string[] = [];
  return {
    done,
    drafted,
    loadLastCheckpointRef: async () => ref,
    recordDone: async (_db, input) => {
      done.push(input.checkpointId);
    },
    draftCheckup: async (_db, input) => {
      drafted.push(input.intentKind);
      return { actionId: 'drafted-1' };
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
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add' }]);
    const verdict = await approvalHandler(s).handle(DB, turn('yes'));

    expect(verdict.claimed).toBe(true);
    expect(s.approved).toEqual(['a-1']);
  });

  it('does not claim ordinary conversation', async () => {
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add' }]);
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
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add' }]);
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
): SequenceReplyDeps & { recorded: Array<{ outcome: string; position: number | null }>; reasks: number } {
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
    const verdict = await sequenceReplyHandler(deps).handle(DB, turn('waitlisted #3'));

    expect(verdict.claimed).toBe(true);
    expect(deps.recorded).toEqual([{ outcome: 'waitlisted', position: 3 }]);
  });

  it('claims a got-in report', async () => {
    const deps = sequenceDeps();
    const verdict = await sequenceReplyHandler(deps).handle(DB, turn("we're in"));

    expect(verdict.claimed).toBe(true);
    expect(deps.recorded).toEqual([{ outcome: 'registered', position: null }]);
  });

  it('claims nothing when no check-in window is open', async () => {
    const deps = sequenceDeps({ open: false });
    const verdict = await sequenceReplyHandler(deps).handle(DB, turn('waitlisted #3'));

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
    const verdict = await sequenceReplyHandler(deps).handle(DB, turn('what a morning'));

    expect(verdict.claimed).toBe(false);
  });

  it('still declines once the re-ask is spent', async () => {
    const deps = sequenceDeps({ reaskedAt: new Date('2026-07-30T09:00:00.000Z') });
    const verdict = await sequenceReplyHandler(deps).handle(DB, turn('what a morning'));

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
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add' }]);
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
    const s = spine([{ actionId: 'a-1', actionType: 'calendar_add' }]);
    const health = healthDeps(PAPERWORK_CHECKPOINT);
    const sequence = sequenceDeps();

    expect((await approvalHandler(s).handle(DB, turn('waitlisted #3'))).claimed).toBe(false);
    expect((await healthReplyHandler(health).handle(DB, turn('waitlisted #3'))).claimed).toBe(false);
    expect((await sequenceReplyHandler(sequence).handle(DB, turn('waitlisted #3'))).claimed).toBe(true);
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
    openProposal: async () => null,
    recordDecision: async () => {},
    cancelOpenProposals: async () => {},
  };

  it('does not swallow a bare yes - it stays the approval lane s to answer', async () => {
    expect((await villageIntroHandler(introDeps).handle(DB, turn('yes'))).claimed).toBe(false);
    const pending = spine([{ actionId: 'act-1', actionType: 'book_checkup' }]);
    expect((await approvalHandler(pending).handle(DB, turn('yes'))).claimed).toBe(true);
    expect(pending.approved).toEqual(['act-1']);
  });

  it('and the approval lane would not have answered YES INTRO even if it ran first', async () => {
    const pending = spine([{ actionId: 'act-1', actionType: 'book_checkup' }]);
    expect((await approvalHandler(pending).handle(DB, turn('YES INTRO'))).claimed).toBe(false);
    expect(pending.approved).toEqual([]);
    expect((await villageIntroHandler(introDeps).handle(DB, turn('YES INTRO'))).claimed).toBe(true);
  });
});

/**
 * The order production actually ships. The tests above drive each handler directly, so
 * without this one the whole ordering argument could hold while `defaultHandlers`
 * returned them in some other sequence.
 */
describe('the shipped order', () => {
  it('is village_intro, then approval, then health, then registration', async () => {
    const { defaultHandlers } = await import('./wiring');
    expect(defaultHandlers().map((h) => h.name)).toEqual([
      'village_intro',
      'approval',
      'health',
      'registration',
    ]);
  });
});
