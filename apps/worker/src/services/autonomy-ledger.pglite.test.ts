import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '../testing/pglite.js';
import {
  hasAutonomousActionOptIn,
  loadHumanApprover,
  recordExecution,
  recordHumanApproval,
  revokeAutonomyForKind,
} from './memory-writer.js';

/**
 * The autonomy ledger against real DDL (Barton, 2026-10-11): one parent message turns
 * Hale's autonomy off for that kind, every autonomous execution's audit row carries its
 * decision and the reviewer's reason, and a resumed checkpoint can tell a parent's
 * approval from Hale's own claim. The switch-off is written to the same
 * consent_records ledger the opt-in reader reads, so a chain fake could not show the
 * reader honouring it.
 */

const POLICY_VERSION = 'test-policy';
const HOUR_MS = 60 * 60 * 1000;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

async function addMember(familyId: string, role: 'co_parent' | 'grandparent') {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${role}-${familyId}@example.test`, name: 'Member' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seed: users insert returned no row');
  await db.database.insert(schema.familyMembers).values({ familyId, userId: user.id, role });
  return user.id;
}

async function grantOptIn(familyId: string, userId: string, kind: string, grantedAt: Date) {
  await db.database.insert(schema.consentRecords).values({
    familyId,
    userId,
    consentType: 'autonomous_action_class',
    consentScope: kind,
    granted: true,
    grantedAt,
    policyVersion: POLICY_VERSION,
  });
}

async function seedOptedInFamily() {
  const fam = await seedFamily(db.database);
  const earlier = new Date(Date.now() - HOUR_MS);
  await grantOptIn(fam.familyId, fam.parentUserId, 'send_email', earlier);
  await grantOptIn(fam.familyId, fam.parentUserId, 'calendar_add', earlier);
  return fam;
}

async function seedAction(familyId: string, dedupHash: string) {
  const [event] = await db.database
    .insert(schema.events)
    .values({ familyId, source: 'test', eventType: 'signal.test', dedupHash, status: 'reviewed' })
    .returning({ id: schema.events.id });
  if (!event) throw new Error('seed: events insert returned no row');
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event.id,
      familyId,
      actionType: 'send_email',
      payload: { to: 'clinic@example.test', subject: 'hi', body: 'drafted words' },
      reviewerVerdict: 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seed: actions insert returned no row');
  return { eventId: event.id, actionId: action.id };
}

const evidence = { reply: 'parent words', interpretation: 'stop doing this on your own' };

describe('revokeAutonomyForKind — one parent message turns a kind off', () => {
  it('the primary parent revokes send_email → that kind is off, calendar_add is untouched, audited', async () => {
    const fam = await seedOptedInFamily();
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);

    const result = await revokeAutonomyForKind(
      {
        familyId: fam.familyId,
        actorUserId: fam.parentUserId,
        kind: 'send_email',
        now: new Date(),
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(result.outcome).toBe('revoked');
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(false);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'calendar_add', db.database)).toBe(true);

    const audit = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, fam.familyId),
          eq(schema.auditLog.actionTaken, 'autonomous_action_class.revoked'),
        ),
      );
    expect(audit).toEqual([
      {
        actor: fam.parentUserId,
        after: { consentType: 'autonomous_action_class', consentScope: 'send_email' },
      },
    ]);
  });

  it("a co-parent's message turns the kind off for the family, not only for them", async () => {
    const fam = await seedOptedInFamily();
    const coParentId = await addMember(fam.familyId, 'co_parent');

    await revokeAutonomyForKind(
      {
        familyId: fam.familyId,
        actorUserId: coParentId,
        kind: 'calendar_add',
        now: new Date(),
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(await hasAutonomousActionOptIn(fam.familyId, 'calendar_add', db.database)).toBe(false);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
  });

  it('a caregiver is not a parent: refused by name, nothing written', async () => {
    const fam = await seedOptedInFamily();
    const caregiverId = await addMember(fam.familyId, 'grandparent');

    const result = await revokeAutonomyForKind(
      {
        familyId: fam.familyId,
        actorUserId: caregiverId,
        kind: 'send_email',
        now: new Date(),
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(result).toEqual({ outcome: 'not_a_parent' });
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
    const rows = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.userId, caregiverId));
    expect(rows).toHaveLength(0);
  });
});

describe('recordExecution — the decision travels on the audit row', () => {
  it('an autonomous execution audits the decision and the reviewer reason; executor_result stays the detail', async () => {
    const fam = await seedFamily(db.database);
    const { actionId } = await seedAction(fam.familyId, 'exec-decision');
    const detail = { kind: 'email_sent', messageId: 'pm-1', recipientDomain: 'example.test' };

    await recordExecution(
      {
        actionId,
        result: detail,
        ok: true,
        decision: { source: 'autonomous', reason: 'all checks green' },
      },
      db.database,
    );

    const [audit] = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetId, actionId), eq(schema.auditLog.actionTaken, 'action.executed')),
      );
    expect(audit).toEqual({
      actor: 'system',
      after: { ...detail, decision: { source: 'autonomous', reason: 'all checks green' } },
    });
    const [action] = await db.database
      .select({ executorResult: schema.actions.executorResult })
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    expect(action?.executorResult).toEqual(detail);
  });
});

describe('loadHumanApprover — whose claim a checkpoint is', () => {
  it('null before a parent approves; the approver once recordHumanApproval claims it', async () => {
    const fam = await seedFamily(db.database);
    const { eventId, actionId } = await seedAction(fam.familyId, 'approver-read');

    expect(await loadHumanApprover(actionId, db.database)).toBeNull();

    await recordHumanApproval(
      { familyId: fam.familyId, eventId, actionId, approvedBy: fam.parentUserId },
      db.database,
    );

    expect(await loadHumanApprover(actionId, db.database)).toBe(fam.parentUserId);
  });
});
