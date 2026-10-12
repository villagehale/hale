import { schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTONOMY_STREAK_REQUIRED, streakSatisfiesAutonomy } from '../orchestrator/autonomy-gate.js';
import { createTestDb, seedFamily, type SeededFamily, type TestDb } from '../testing/pglite.js';
import {
  hasAutonomousActionOptIn,
  loadActionApprovalHistory,
  loadCrossParentConsent,
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

async function seedAction(
  familyId: string,
  dedupHash: string,
  actionType: ActionType = 'send_email',
) {
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
      actionType,
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
      {
        familyId: fam.familyId,
        eventId,
        actionId,
        approvedBy: fam.parentUserId,
        policyVersion: POLICY_VERSION,
      },
      db.database,
    );

    expect(await loadHumanApprover(actionId, db.database)).toBe(fam.parentUserId);
  });
});

/**
 * How a kind becomes autonomous (Sloane's answers, 2026-10-12): the fifth parent
 * approval of a kind writes its grant, an approval is the action.approved_by_human
 * row and nothing else, and a switch-off restarts the count. Each approval below is
 * the production sequence, recordHumanApproval then recordExecution, because the
 * execution is what stamps user_visible_state.
 */

let sequence = 0;

async function approve(fam: SeededFamily, kind: ActionType, approvedBy = fam.parentUserId) {
  sequence += 1;
  const { eventId, actionId } = await seedAction(fam.familyId, `approved-${sequence}`, kind);
  await recordHumanApproval(
    { familyId: fam.familyId, eventId, actionId, approvedBy, policyVersion: POLICY_VERSION },
    db.database,
  );
  await recordExecution(
    {
      actionId,
      result: { kind: 'test' },
      ok: true,
      decision: { source: 'human', reason: 'a parent approved it' },
    },
    db.database,
  );
}

async function approveTimes(fam: SeededFamily, kind: ActionType, times: number) {
  for (let i = 0; i < times; i += 1) {
    await approve(fam, kind);
  }
}

async function runOnItsOwn(fam: SeededFamily, kind: ActionType) {
  sequence += 1;
  const { actionId } = await seedAction(fam.familyId, `autonomous-${sequence}`, kind);
  await recordExecution(
    {
      actionId,
      result: { kind: 'test' },
      ok: true,
      decision: { source: 'autonomous', reason: 'all checks green' },
    },
    db.database,
  );
}

async function streakReached(fam: SeededFamily, kind: ActionType) {
  return streakSatisfiesAutonomy(
    kind,
    await loadActionApprovalHistory(fam.familyId, kind, db.database),
  );
}

async function autonomyConsentRows(familyId: string) {
  return db.database
    .select({
      userId: schema.consentRecords.userId,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
      policyVersion: schema.consentRecords.policyVersion,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
      ),
    )
    .orderBy(asc(schema.consentRecords.grantedAt));
}

async function grantAuditRows(familyId: string) {
  return db.database
    .select({
      actor: schema.auditLog.actor,
      targetTable: schema.auditLog.targetTable,
      after: schema.auditLog.after,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'autonomous_action_class.granted'),
      ),
    );
}

function switchOff(fam: SeededFamily, kind: ActionType, actorUserId = fam.parentUserId) {
  return revokeAutonomyForKind(
    {
      familyId: fam.familyId,
      actorUserId,
      kind,
      now: new Date(),
      policyVersion: POLICY_VERSION,
      evidence,
    },
    db.database,
  );
}

describe('the approval streak is counted from the parent approval rows', () => {
  it('five real approvals reach it, each one executed; four do not', async () => {
    const fam = await seedFamily(db.database);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await streakReached(fam, 'send_email')).toBe(false);

    await approve(fam, 'send_email');
    expect(await streakReached(fam, 'send_email')).toBe(true);
    expect(await streakReached(fam, 'calendar_add')).toBe(false);
  });

  it('runs Hale made on its own never count toward it', async () => {
    const fam = await seedFamily(db.database);

    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED; i += 1) {
      await runOnItsOwn(fam, 'send_email');
    }
    expect(await streakReached(fam, 'send_email')).toBe(false);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await runOnItsOwn(fam, 'send_email');
    expect(await streakReached(fam, 'send_email')).toBe(false);
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
  });

  it('a run Hale made on its own does not undo a streak the parent already built', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);

    await runOnItsOwn(fam, 'send_email');

    expect(await streakReached(fam, 'send_email')).toBe(true);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
  });
});

describe('the fifth approval of a kind writes its grant', () => {
  it('four approvals write nothing; the fifth writes one grant for that kind and logs it', async () => {
    const fam = await seedFamily(db.database);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
    expect(await grantAuditRows(fam.familyId)).toEqual([]);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(false);

    await approve(fam, 'send_email');

    expect(await autonomyConsentRows(fam.familyId)).toEqual([
      {
        userId: fam.parentUserId,
        consentScope: 'send_email',
        granted: true,
        revokedAt: null,
        policyVersion: POLICY_VERSION,
      },
    ]);
    expect(await grantAuditRows(fam.familyId)).toEqual([
      {
        actor: fam.parentUserId,
        targetTable: 'consent_records',
        after: {
          consentType: 'autonomous_action_class',
          consentScope: 'send_email',
          approvals: AUTONOMY_STREAK_REQUIRED,
        },
      },
    ]);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'reply_to_email', db.database)).toBe(false);

    await approve(fam, 'send_email');
    expect(await autonomyConsentRows(fam.familyId)).toHaveLength(1);
  });

  it.each(['book_clinic_portal', 'submit_government_form', 'place_supply_order'] as const)(
    'a never-autonomous kind (%s) gets no grant however many approvals',
    async (deniedKind) => {
      const fam = await seedFamily(db.database);

      await approveTimes(fam, deniedKind, AUTONOMY_STREAK_REQUIRED + 2);
      expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
      expect(await grantAuditRows(fam.familyId)).toEqual([]);

      // Positive control: the same family, the same writer, an allowed kind.
      await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
      expect((await autonomyConsentRows(fam.familyId)).map((row) => row.consentScope)).toEqual([
        'send_email',
      ]);
    },
  );

  it("a co-parent's approvals count, but only the primary parent's own approval writes the grant", async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await approve(fam, 'send_email', coParentId);

    // No row under the co-parent: a granted one would also read as their cross-parent consent.
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
    expect(await loadCrossParentConsent(fam.familyId, db.database)).toEqual({
      hasCoParent: true,
      coParentConsentGranted: false,
    });

    await approve(fam, 'send_email');

    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.userId)).toEqual([
      fam.parentUserId,
    ]);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
  });
});

describe('a switch-off restarts the streak', () => {
  it('four approvals after it do not re-arm the kind; the fifth does', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);

    await switchOff(fam, 'send_email');
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(false);
    expect(await streakReached(fam, 'send_email')).toBe(false);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await streakReached(fam, 'send_email')).toBe(false);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(false);

    await approve(fam, 'send_email');
    expect(await streakReached(fam, 'send_email')).toBe(true);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.granted)).toEqual([
      true,
      false,
      true,
    ]);
    expect(await grantAuditRows(fam.familyId)).toHaveLength(2);
  });

  it("a co-parent's switch-off restarts it too, and switching one kind off leaves another armed", async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED);

    await switchOff(fam, 'send_email', coParentId);

    expect(await streakReached(fam, 'send_email')).toBe(false);
    expect(await streakReached(fam, 'calendar_add')).toBe(true);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'calendar_add', db.database)).toBe(true);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(await hasAutonomousActionOptIn(fam.familyId, 'send_email', db.database)).toBe(true);
  });
});
