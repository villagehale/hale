import { schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { AUTONOMY_STREAK_REQUIRED } from '@hale/worker/autonomy-gate';
import { loadAutonomyStanding, recordHumanApproval } from '@hale/worker/memory-writer';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { declineDraftedAction } from './decline';
import { reverseExecutedCalendarAction } from './reverse-calendar';

/**
 * A dismissed draft ends the approval streak (rule #4: consecutive means consecutive),
 * and so does undoing something Hale did. The dismissal and the undo here are the
 * production ones, `declineDraftedAction` and `reverseExecutedCalendarAction`, the
 * functions both the text reply and the web button call, and the streak is read by the
 * worker's own reader. A hand-seeded audit row could not show that they agree on its
 * shape.
 */

let db: TestDb;
let sequence = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function draft(fam: SeededFamily, kind: ActionType) {
  sequence += 1;
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: `decline-streak-${sequence}`,
      status: 'reviewed',
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('seed: events insert returned no row');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event.id,
      familyId: fam.familyId,
      actionType: kind,
      payload: { to: 'office@example.test', subject: 'hi', body: 'drafted words' },
      reviewerVerdict: 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seed: actions insert returned no row');
  return { eventId: event.id, actionId: action.id };
}

async function approve(fam: SeededFamily, kind: ActionType) {
  const { eventId, actionId } = await draft(fam, kind);
  return recordHumanApproval(
    {
      familyId: fam.familyId,
      eventId,
      actionId,
      approvedBy: fam.parentUserId,
      policyVersion: 'test-policy',
    },
    db.database,
  );
}

async function dismiss(fam: SeededFamily, kind: ActionType) {
  const { actionId } = await draft(fam, kind);
  return declineDraftedAction(db.database, {
    actionId,
    familyId: fam.familyId,
    declinedBy: fam.parentUserId,
  });
}

/** Undoes a calendar entry Hale placed, through the production undo. Nothing leaves the process. */
async function undoPlacement(fam: SeededFamily) {
  const { actionId } = await draft(fam, 'calendar_add');
  const executedAt = new Date();
  await db.database
    .update(schema.actions)
    .set({
      userVisibleState: 'autonomous',
      executedAt,
      executorResult: { kind: 'calendar_placed', reversalHandle: randomUUID() },
    })
    .where(eq(schema.actions.id, actionId));
  return reverseExecutedCalendarAction(db.database, {
    actionId,
    familyId: fam.familyId,
    revertedBy: fam.parentUserId,
    now: executedAt,
    capture: async () => 'not_configured' as const,
    withdrawInvites: async () => ({ status: 'not_configured' }),
    googleCalendar: { sync: async () => ({ status: 'skipped', reason: 'flag_off' }) },
  });
}

async function grants(familyId: string) {
  return db.database
    .select({ consentScope: schema.consentRecords.consentScope })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
      ),
    );
}

describe('a draft dismissed through declineDraftedAction breaks the approval streak', () => {
  it('four approvals, one dismissal, one approval: the kind is not armed', async () => {
    const fam = await seedFamily(db.database);
    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED - 1; i += 1) await approve(fam, 'send_email');

    expect(await dismiss(fam, 'send_email')).toEqual({ status: 200 });
    const afterDismissal = await approve(fam, 'send_email');

    expect(afterDismissal).toEqual({ claimed: true, autonomy: { outcome: 'not_reached' } });
    expect(await grants(fam.familyId)).toEqual([]);
    expect(await loadAutonomyStanding(fam.familyId, 'send_email', db.database)).toEqual([
      { parentUserId: fam.parentUserId, streakReached: false, optedIn: false },
    ]);
  });

  it('positive control: dismissing a draft of another kind leaves the fifth approval arming', async () => {
    const fam = await seedFamily(db.database);
    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED - 1; i += 1) await approve(fam, 'send_email');

    expect(await dismiss(fam, 'calendar_add')).toEqual({ status: 200 });
    const fifth = await approve(fam, 'send_email');

    expect(fifth).toMatchObject({ claimed: true, autonomy: { outcome: 'granted' } });
    expect(await grants(fam.familyId)).toEqual([{ consentScope: 'send_email' }]);
  });
});

describe('a calendar entry undone through reverseExecutedCalendarAction breaks the approval streak', () => {
  it('four approvals, one undo, one approval: the kind is not armed', async () => {
    const fam = await seedFamily(db.database);
    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED - 1; i += 1) await approve(fam, 'calendar_add');

    expect(await undoPlacement(fam)).toMatchObject({ status: 200 });
    const afterUndo = await approve(fam, 'calendar_add');

    expect(afterUndo).toEqual({ claimed: true, autonomy: { outcome: 'not_reached' } });
    expect(await grants(fam.familyId)).toEqual([]);
  });

  it('an undo after the kind turned on holds it again', async () => {
    const fam = await seedFamily(db.database);
    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED; i += 1) await approve(fam, 'calendar_add');
    expect(await loadAutonomyStanding(fam.familyId, 'calendar_add', db.database)).toEqual([
      { parentUserId: fam.parentUserId, streakReached: true, optedIn: true },
    ]);

    expect(await undoPlacement(fam)).toMatchObject({ status: 200 });

    expect(await loadAutonomyStanding(fam.familyId, 'calendar_add', db.database)).toEqual([
      { parentUserId: fam.parentUserId, streakReached: false, optedIn: true },
    ]);
  });
});
