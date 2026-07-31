import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { HealthReplyDeps } from '~/lib/health/reply';
import type { ApprovalSpine, PendingAction } from './approval';
import { approvalHandler, healthReplyHandler } from './handlers';
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
    expect(verdict.claimed && verdict.reply).toMatch(/approve/i);
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
