import { schema } from '@hale/db';
import { type IngestedEventPayload, REQUIRED_CHECKS } from '@hale/tools-contracts';
import type { ActionType } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupHashFor } from '../agents/dedup.js';
import type {
  GoogleCalendarPlacement,
  GoogleCalendarWriteTarget,
} from '../services/google-calendar-placement.js';
import { autonomyArmedDedupeKey, recordHumanApproval } from '../services/memory-writer.js';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import { AUTONOMY_STREAK_REQUIRED } from './autonomy-gate.js';
import { defaultExecuteApprovedDeps, executeApprovedAction, runOrchestrator } from './index.js';

/**
 * VIL-719 · the ask policy's promise, against real DDL: an ask-first action never runs
 * without the parent's recorded yes. The approval row, the consent rows, the streak and
 * the event checkpoint are the production writers' and readers'. Only the executor is
 * replaced, because reaching it is the thing under test. No model is involved.
 */

let db: TestDb;
let sequence = 0;

vi.mock('../db.js', () => ({ db: () => db.database }));

const runExecutor = vi.fn(async () => ({ ok: true, detail: { kind: 'test' } }));
vi.mock('../services/executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/executor.js')>()),
  runExecutor: () => runExecutor(),
}));

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  runExecutor.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function seedAction(
  fam: SeededFamily,
  kind: ActionType,
  status: 'reviewed' | 'approved_pending_execute',
  payload: Record<string, unknown> = {},
) {
  sequence += 1;
  const eventPayload = { messageId: `ask-policy-door-${sequence}` };
  const job: IngestedEventPayload = {
    family_id: fam.familyId,
    source: 'gmail',
    payload: eventPayload,
    received_at: '2026-11-20T15:00:00.000Z',
  };
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: job.source,
      eventType: 'signal.test',
      dedupHash: dedupHashFor(fam.familyId, job.source, JSON.stringify(eventPayload)),
      payload: eventPayload,
      status,
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('seed: events insert returned no row');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event.id,
      familyId: fam.familyId,
      actionType: kind,
      payload,
      reviewerVerdict: 'approved',
      reviewerToolResults: REQUIRED_CHECKS[kind].map((tool) => ({ tool, ok: true, result: {} })),
      userVisibleState: 'drafted_for_approval',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seed: actions insert returned no row');
  return { job, eventId: event.id, actionId: action.id };
}

async function eventStatus(eventId: string) {
  const [row] = await db.database
    .select({ status: schema.events.status })
    .from(schema.events)
    .where(eq(schema.events.id, eventId));
  return row?.status;
}

async function auditAfter(actionId: string, verb: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.targetId, actionId), eq(schema.auditLog.actionTaken, verb)));
  return rows.map((row) => row.after);
}

function tap(fam: SeededFamily, actionId: string) {
  return executeApprovedAction(
    {
      actionId,
      familyId: fam.familyId,
      approvedBy: fam.parentUserId,
      policyVersion: 'test-policy',
    },
    {
      ...defaultExecuteApprovedDeps(),
      checkWindow: async () => ({ withinWindow: true, detail: {} }),
    },
  );
}

async function seedCoParent(fam: SeededFamily) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-parent-${fam.familyId}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seed: users insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId: fam.familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

/** The real path to autonomy: five approvals write the grant, then its turn-on text lands. */
async function earnAutonomy(fam: SeededFamily, kind: ActionType) {
  let consentRecordId: string | undefined;
  for (let i = 0; i < AUTONOMY_STREAK_REQUIRED; i += 1) {
    const seeded = await seedAction(fam, kind, 'reviewed');
    const claim = await recordHumanApproval(
      {
        familyId: fam.familyId,
        eventId: seeded.eventId,
        actionId: seeded.actionId,
        approvedBy: fam.parentUserId,
        policyVersion: 'test-policy',
      },
      db.database,
    );
    if (claim.claimed && claim.autonomy.outcome === 'granted') {
      consentRecordId = claim.autonomy.consentRecordId;
    }
  }
  if (!consentRecordId) throw new Error('seed: the fifth approval wrote no grant');
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: 'system',
    actionTaken: 'autonomy_armed_notice_sent',
    targetTable: 'consent_records',
    targetId: consentRecordId,
    after: { dedupeKey: autonomyArmedDedupeKey(consentRecordId) },
  });
}

function googleTo(target: GoogleCalendarWriteTarget): GoogleCalendarPlacement {
  return {
    sync: async () => ({ status: 'skipped', reason: 'flag_off' }),
    writeTarget: async () => target,
  };
}

describe('an ask-first action and the recorded yes', () => {
  it('a streak and a grant from before the flag are not a yes: the checkpoint goes back to the parent', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const fam = await seedFamily(db.database);
    await earnAutonomy(fam, 'send_email');
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const seeded = await seedAction(fam, 'send_email', 'approved_pending_execute');
    await runOrchestrator(seeded.job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(await eventStatus(seeded.eventId)).toBe('reviewed');
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([
      {
        actionType: 'send_email',
        askTier: 'ask_first',
        classes: ['contact_third_party'],
        resumed: true,
      },
    ]);
    expect(await auditAfter(seeded.actionId, 'action.executed')).toEqual([]);
  });

  it("another action's approval row is not this action's yes", async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const other = await seedAction(fam, 'send_email', 'reviewed');
    await recordHumanApproval(
      {
        familyId: fam.familyId,
        eventId: other.eventId,
        actionId: other.actionId,
        approvedBy: fam.parentUserId,
        policyVersion: 'test-policy',
      },
      db.database,
    );
    const seeded = await seedAction(fam, 'send_email', 'approved_pending_execute');
    await runOrchestrator(seeded.job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(await eventStatus(seeded.eventId)).toBe('reviewed');
  });

  it('a tap that lands on that checkpoint recorded no yes, so the door holds it', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const seeded = await seedAction(fam, 'send_email', 'approved_pending_execute');
    await tap(fam, seeded.actionId);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(await eventStatus(seeded.eventId)).toBe('reviewed');
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([
      {
        actionType: 'send_email',
        askTier: 'ask_first',
        classes: ['contact_third_party'],
        backstop: true,
      },
    ]);
  });

  it("positive control: the parent's real approval records the yes and the action runs once", async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const seeded = await seedAction(fam, 'send_email', 'reviewed');
    await tap(fam, seeded.actionId);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(await auditAfter(seeded.actionId, 'action.approved_by_human')).toEqual([
      { approvedBy: fam.parentUserId },
    ]);
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([]);
    expect(await eventStatus(seeded.eventId)).toBe('actioned');
  });

  it('policy off: the same earned, autonomous checkpoint runs, as it does today', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const fam = await seedFamily(db.database);
    await earnAutonomy(fam, 'send_email');
    const seeded = await seedAction(fam, 'send_email', 'approved_pending_execute');
    await runOrchestrator(seeded.job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([]);
    expect(await eventStatus(seeded.eventId)).toBe('actioned');
  });
});

describe('a calendar action that has earned autonomy, and whose Google calendar it reaches', () => {
  it("held for a yes when the write would land on the co-parent's own calendar", async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const coParent = await seedCoParent(fam);
    await earnAutonomy(fam, 'calendar_add');
    const seeded = await seedAction(fam, 'calendar_add', 'approved_pending_execute', {
      title: 'Swim',
      startsAt: '2026-12-05T15:00:00.000Z',
    });
    await runOrchestrator(seeded.job, {
      googleCalendar: googleTo({ writes: true, ownerUserId: coParent }),
    });
    expect(runExecutor).not.toHaveBeenCalled();
    expect(await eventStatus(seeded.eventId)).toBe('reviewed');
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([
      {
        actionType: 'calendar_add',
        askTier: 'ask_first',
        classes: ['family_calendar', 'other_persons_info'],
        writesAnotherParentsCalendar: true,
      },
    ]);
  });

  it("positive control: runs when the write lands on the grant holder's own calendar", async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    await seedCoParent(fam);
    await earnAutonomy(fam, 'calendar_add');
    const seeded = await seedAction(fam, 'calendar_add', 'approved_pending_execute', {
      title: 'Swim',
      startsAt: '2026-12-05T15:00:00.000Z',
    });
    await runOrchestrator(seeded.job, {
      googleCalendar: googleTo({ writes: true, ownerUserId: fam.parentUserId }),
    });
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(await auditAfter(seeded.actionId, 'action.gated.ask_first')).toEqual([]);
    expect(await eventStatus(seeded.eventId)).toBe('actioned');
  });
});
