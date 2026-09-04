import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadActionForApproval, recordHumanApproval } from '../services/memory-writer.js';
import { createTestDb, seedFamily, type TestDb } from '../testing/pglite.js';
import { executeApprovedAction, type ExecuteApprovedDeps } from './index.js';

/**
 * The human-approval record is a CLAIM (audit P1-4 seam 2). Two deliveries of one
 * actions.approved job — expiry redelivery, or the SMS "YES" arc racing the web
 * button before the job-id dedupe existed — both passed the read-only
 * `userVisibleState === 'drafted_for_approval'` gate, because that state only changes
 * when execution FINISHES. recordHumanApproval's conditional UPDATE (FROM 'reviewed'
 * only, RETURNING its row count) is what admits exactly one: the loser records no
 * second "the parent approved this" audit row, and a stale redelivery can never drag
 * a finished event back to the checkpoint. Real DDL, real writes — a chain fake can
 * never lose a claim (the injected-fakes lesson).
 *
 * Mutation proof: drop the status predicate from recordHumanApproval's UPDATE (the
 * pre-fix unconditional write) and both tests fail — the racer records two approval
 * audit rows, and the late redelivery regresses 'actioned' and re-executes.
 */

const VERDICT_TOOL_RESULTS = [
  { tool: 'check_pii_leak', ok: true, result: {} },
  { tool: 'check_recipient_allowlist', ok: true, result: {} },
  { tool: 'check_action_idempotency', ok: true, result: {} },
];

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

async function seedApprovableAction(dedupHash: string) {
  const fam = await seedFamily(db.database);
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash,
      status: 'reviewed',
    })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('seed: events insert returned no row');

  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event.id,
      familyId: fam.familyId,
      actionType: 'send_email',
      payload: { to: 'clinic@x.ca', subject: 'hi', body: 'hello' },
      reviewerVerdict: 'approved',
      reviewerToolResults: VERDICT_TOOL_RESULTS,
      userVisibleState: 'drafted_for_approval',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seed: actions insert returned no row');

  return { ...fam, eventId: event.id, actionId: action.id };
}

function makeDeps(execute: ExecuteApprovedDeps['execute']) {
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps: ExecuteApprovedDeps = {
    loadAction: (actionId) => loadActionForApproval(actionId, db.database),
    loadConsent: async () => ({ hasCoParent: false, coParentConsentGranted: false }),
    recordApproval: (input) => recordHumanApproval(input, db.database),
    recordGate: vi.fn(async () => {}),
    execute,
    log,
  };
  return { deps, log };
}

async function approvalAuditRows(actionId: string) {
  return db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'action.approved_by_human'),
        eq(schema.auditLog.targetId, actionId),
      ),
    );
}

describe('executeApprovedAction human-approval claim', () => {
  it('two live deliveries record the approval exactly once; the loser is a NAMED resume', async () => {
    const seeded = await seedApprovableAction('claim-race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const { deps, log } = makeDeps(
      vi.fn(async () => {
        started += 1;
        await gate;
      }),
    );
    const input = {
      actionId: seeded.actionId,
      familyId: seeded.familyId,
      approvedBy: seeded.parentUserId,
    };

    // Delivery A claims and parks inside the executor — the exact window in which
    // delivery B arrives on an expiry redelivery.
    const first = executeApprovedAction(input, deps);
    await vi.waitFor(() => expect(started).toBe(1));

    // Delivery B passes the read-only state gate (nothing has changed the action row),
    // loses the claim, and RESUMES rather than re-records: the executor's own
    // effect-level claims are the double-send guard, this seam's claim is the
    // record-once guard.
    const second = executeApprovedAction(input, deps);
    await vi.waitFor(() => expect(started).toBe(2));
    release();
    await Promise.all([first, second]);

    expect(await approvalAuditRows(seeded.actionId)).toHaveLength(1);
    const [event] = await db.database
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, seeded.eventId));
    expect(event?.status).toBe('approved_pending_execute');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: seeded.actionId }),
      expect.stringContaining('resuming into executor'),
    );
  });

  it('a late redelivery can never drag a finished event back to the checkpoint', async () => {
    const seeded = await seedApprovableAction('claim-late-redelivery');
    const execute = vi.fn(async () => {});
    const { deps, log } = makeDeps(execute);
    const input = {
      actionId: seeded.actionId,
      familyId: seeded.familyId,
      approvedBy: seeded.parentUserId,
    };

    await executeApprovedAction(input, deps);
    expect(execute).toHaveBeenCalledTimes(1);

    // Execution finishes: the event reaches its terminal stage. The action row is left
    // at drafted_for_approval to model the STALE-GATE world — the redelivery whose
    // loadAction read raced the execution's own state write.
    await db.database
      .update(schema.events)
      .set({ status: 'actioned' })
      .where(eq(schema.events.id, seeded.eventId));

    await executeApprovedAction(input, deps);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await approvalAuditRows(seeded.actionId)).toHaveLength(1);
    const [event] = await db.database
      .select({ status: schema.events.status })
      .from(schema.events)
      .where(eq(schema.events.id, seeded.eventId));
    expect(event?.status).toBe('actioned');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: seeded.actionId, eventStatus: 'actioned' }),
      expect.stringContaining('dropping duplicate delivery'),
    );
  });
});
