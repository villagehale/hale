import { schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTONOMY_STREAK_REQUIRED } from '../orchestrator/autonomy-gate.js';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import {
  autonomyArmedDedupeKey,
  autonomyTurnOnDelivered,
  loadAutonomyStanding,
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

/** Each parent's standing for a kind, by user id. */
async function standing(familyId: string, kind: ActionType) {
  const rows = await loadAutonomyStanding(familyId, kind, db.database);
  return new Map(
    rows.map((row) => [
      row.parentUserId,
      { streakReached: row.streakReached, optedIn: row.optedIn },
    ]),
  );
}

/** Whether any parent's grant for the kind is live. */
async function optedIn(familyId: string, kind: ActionType) {
  return [...(await standing(familyId, kind)).values()].some((parent) => parent.optedIn);
}

/** What the orchestrator requires before Hale acts on its own: one parent holding both. */
async function armed(familyId: string, kind: ActionType) {
  return [...(await standing(familyId, kind)).values()].some(
    (parent) => parent.streakReached && parent.optedIn,
  );
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
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);

    const result = await revokeAutonomyForKind(
      {
        familyId: fam.familyId,
        actorUserId: fam.parentUserId,
        kind: 'send_email',
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(result.outcome).toBe('revoked');
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'calendar_add')).toBe(true);

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
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(await optedIn(fam.familyId, 'calendar_add')).toBe(false);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);
  });

  it('a caregiver is not a parent: refused by name, nothing written', async () => {
    const fam = await seedOptedInFamily();
    const caregiverId = await addMember(fam.familyId, 'grandparent');

    const result = await revokeAutonomyForKind(
      {
        familyId: fam.familyId,
        actorUserId: caregiverId,
        kind: 'send_email',
        policyVersion: POLICY_VERSION,
        evidence,
      },
      db.database,
    );

    expect(result).toEqual({ outcome: 'not_a_parent' });
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);
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
        and(
          eq(schema.auditLog.targetId, actionId),
          eq(schema.auditLog.actionTaken, 'action.executed'),
        ),
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
 * How a kind becomes autonomous (Barton, 2026-10-12): each parent's own five approvals
 * in a row arm it under that parent, a dismissed draft or a switch-off ends the run,
 * and either parent's switch-off turns the kind off for the family. An approval is the
 * action.approved_by_human row and nothing else. Each approval below is the production
 * sequence, recordHumanApproval then recordExecution, because the execution is what
 * stamps user_visible_state.
 */

let sequence = 0;

async function approve(fam: SeededFamily, kind: ActionType, approvedBy = fam.parentUserId) {
  sequence += 1;
  const { eventId, actionId } = await seedAction(fam.familyId, `approved-${sequence}`, kind);
  const claim = await recordHumanApproval(
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
  return claim;
}

/** The row `declineDraftedAction` writes when a parent dismisses a draft (apps/web/lib/actions/decline.ts). */
async function dismiss(fam: SeededFamily, kind: ActionType, declinedBy = fam.parentUserId) {
  sequence += 1;
  const { actionId } = await seedAction(fam.familyId, `dismissed-${sequence}`, kind);
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: declinedBy,
    actionTaken: 'action.declined_by_human',
    targetTable: 'actions',
    targetId: actionId,
  });
}

/** The row `reverseExecutedCalendarAction` writes on the action when a parent undoes it (apps/web/lib/actions/reverse-calendar.ts). */
async function undo(fam: SeededFamily, kind: ActionType, revertedBy = fam.parentUserId) {
  sequence += 1;
  const { actionId } = await seedAction(fam.familyId, `undone-${sequence}`, kind);
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: revertedBy,
    actionTaken: 'action.reverted_by_human',
    targetTable: 'actions',
    targetId: actionId,
  });
}

async function approveTimes(
  fam: SeededFamily,
  kind: ActionType,
  times: number,
  approvedBy = fam.parentUserId,
) {
  for (let i = 0; i < times; i += 1) {
    await approve(fam, kind, approvedBy);
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

async function streakReached(fam: SeededFamily, kind: ActionType, parent = fam.parentUserId) {
  return (await standing(fam.familyId, kind)).get(parent)?.streakReached;
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
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
  });
});

describe('a dismissed draft breaks the streak', () => {
  it('four approvals, one dismissal, one approval: not armed, and no grant is written', async () => {
    const fam = await seedFamily(db.database);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await dismiss(fam, 'send_email');
    await approve(fam, 'send_email');

    expect(await streakReached(fam, 'send_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
  });

  it('five approvals in a row after the dismissal arm it', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await dismiss(fam, 'send_email');

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await streakReached(fam, 'send_email')).toBe(false);

    await approve(fam, 'send_email');
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
  });

  it('dismissing a draft of another kind leaves this kind’s streak alone', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);

    await dismiss(fam, 'calendar_add');
    await approve(fam, 'send_email');

    expect(await streakReached(fam, 'send_email')).toBe(true);
  });

  it('a dismissal after arming holds the kind again, with the grant still on the ledger', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(await armed(fam.familyId, 'send_email')).toBe(true);

    await dismiss(fam, 'send_email');

    expect(await armed(fam.familyId, 'send_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);
  });
});

describe('undoing something Hale did breaks the streak, the same as a dismissal', () => {
  it('four approvals, one undo, one approval: not armed, and no grant is written', async () => {
    const fam = await seedFamily(db.database);

    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED - 1);
    await undo(fam, 'calendar_add');
    await approve(fam, 'calendar_add');

    expect(await streakReached(fam, 'calendar_add')).toBe(false);
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);

    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await armed(fam.familyId, 'calendar_add')).toBe(true);
  });

  it('an undo after arming holds the kind again; the other parent’s undo does not', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED);

    await undo(fam, 'calendar_add', coParentId);
    expect(await armed(fam.familyId, 'calendar_add')).toBe(true);

    await undo(fam, 'calendar_add');
    expect(await armed(fam.familyId, 'calendar_add')).toBe(false);
  });

  it('an undo of a run Hale made on its own restarts every granted parent, and the grant stays', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED);
    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED, coParentId);
    expect(await armed(fam.familyId, 'calendar_add')).toBe(true);

    await undoAutonomous(fam, 'calendar_add', coParentId);

    const after = await standing(fam.familyId, 'calendar_add');
    expect(after.get(fam.parentUserId)).toEqual({ streakReached: false, optedIn: true });
    expect(after.get(coParentId)).toEqual({ streakReached: false, optedIn: true });
    const revoked = await db.database
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, fam.familyId),
          eq(schema.auditLog.actionTaken, 'autonomous_action_class.revoked'),
        ),
      );
    expect(revoked).toEqual([]);
  });
});

async function undoAutonomous(fam: SeededFamily, kind: ActionType, revertedBy: string) {
  sequence += 1;
  const { actionId } = await seedAction(fam.familyId, `autonomous-undone-${sequence}`, kind);
  await recordExecution(
    {
      actionId,
      result: { kind: 'test' },
      ok: true,
      decision: { source: 'autonomous', reason: 'the kind was on' },
    },
    db.database,
  );
  await db.database.insert(schema.auditLog).values({
    familyId: fam.familyId,
    actor: revertedBy,
    actionTaken: 'action.reverted_by_human',
    targetTable: 'actions',
    targetId: actionId,
  });
}

describe('the fifth approval of a kind writes its grant', () => {
  it('four approvals write nothing; the fifth writes one grant for that kind and logs it', async () => {
    const fam = await seedFamily(db.database);

    const early = [];
    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED - 1; i += 1) {
      early.push(await approve(fam, 'send_email'));
    }
    expect(early).toEqual(
      early.map(() => ({ claimed: true, autonomy: { outcome: 'not_reached' } })),
    );
    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
    expect(await grantAuditRows(fam.familyId)).toEqual([]);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);

    const fifth = await approve(fam, 'send_email');

    const [grantRow] = await db.database
      .select({ id: schema.consentRecords.id })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.familyId, fam.familyId));
    expect(fifth).toEqual({
      claimed: true,
      autonomy: { outcome: 'granted', consentRecordId: grantRow?.id },
    });
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
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
    expect(await optedIn(fam.familyId, 'reply_to_email')).toBe(false);

    expect(await approve(fam, 'send_email')).toEqual({
      claimed: true,
      autonomy: { outcome: 'already_on' },
    });
    expect(await autonomyConsentRows(fam.familyId)).toHaveLength(1);
  });

  it.each(['book_clinic_portal', 'submit_government_form', 'place_supply_order'] as const)(
    'a never-autonomous kind (%s) gets no grant however many approvals',
    async (deniedKind) => {
      const fam = await seedFamily(db.database);

      for (let i = 0; i < AUTONOMY_STREAK_REQUIRED + 2; i += 1) {
        expect(await approve(fam, deniedKind)).toEqual({
          claimed: true,
          autonomy: { outcome: 'denied_kind' },
        });
      }
      expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
      expect(await grantAuditRows(fam.familyId)).toEqual([]);

      // Positive control: the same family, the same writer, an allowed kind.
      await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
      expect((await autonomyConsentRows(fam.familyId)).map((row) => row.consentScope)).toEqual([
        'send_email',
      ]);
    },
  );

  it('someone who is not a parent never gets a grant, whatever they approve', async () => {
    const fam = await seedFamily(db.database);
    const caregiverId = await addMember(fam.familyId, 'grandparent');

    for (let i = 0; i < AUTONOMY_STREAK_REQUIRED; i += 1) {
      expect(await approve(fam, 'send_email', caregiverId)).toEqual({
        claimed: true,
        autonomy: { outcome: 'not_a_parent' },
      });
    }

    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
    expect(await armed(fam.familyId, 'send_email')).toBe(false);
  });
});

describe('grants are per parent: each parent’s own approvals arm the kind under them', () => {
  it('a co-parent’s five approvals write the grant under the co-parent, with no primary approval', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED, coParentId);

    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.userId)).toEqual([
      coParentId,
    ]);
    expect((await grantAuditRows(fam.familyId)).map((row) => row.actor)).toEqual([coParentId]);
    expect(await standing(fam.familyId, 'send_email')).toEqual(
      new Map([
        [fam.parentUserId, { streakReached: false, optedIn: false }],
        [coParentId, { streakReached: true, optedIn: true }],
      ]),
    );
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
  });

  it('approvals are not pooled: four from one parent and four from the other arm nobody', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1, coParentId);

    expect(await autonomyConsentRows(fam.familyId)).toEqual([]);
    expect(await armed(fam.familyId, 'send_email')).toBe(false);

    // Positive control: one more from either parent completes that parent's own five.
    await approve(fam, 'send_email');
    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.userId)).toEqual([
      fam.parentUserId,
    ]);
  });

  it('each parent who reaches five gets their own grant row', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED, coParentId);

    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.userId)).toEqual([
      fam.parentUserId,
      coParentId,
    ]);
  });

  it('a parent’s dismissal breaks their own streak and leaves the other parent’s alone', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1, coParentId);

    await dismiss(fam, 'send_email', coParentId);
    await approve(fam, 'send_email');
    await approve(fam, 'send_email', coParentId);

    expect(await standing(fam.familyId, 'send_email')).toEqual(
      new Map([
        [fam.parentUserId, { streakReached: true, optedIn: true }],
        [coParentId, { streakReached: false, optedIn: false }],
      ]),
    );
  });

  it('a parent in two families: a grant or a switch-off in one is not read in the other', async () => {
    const famA = await seedFamily(db.database);
    const famB = await seedFamily(db.database);
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: famB.familyId, userId: famA.parentUserId, role: 'co_parent' });
    await approveTimes(famA, 'send_email', AUTONOMY_STREAK_REQUIRED);

    expect((await standing(famB.familyId, 'send_email')).get(famA.parentUserId)).toEqual({
      streakReached: false,
      optedIn: false,
    });

    await switchOff(famB, 'send_email', famA.parentUserId);

    expect(await armed(famA.familyId, 'send_email')).toBe(true);
  });
});

describe('a co-parent’s grant for one kind is not their consent to a cross-parent kind', () => {
  it('reads only the co-parent’s own live grant for the kind being asked about, in this family', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED, coParentId);

    expect(
      await loadCrossParentConsent(fam.familyId, 'create_calendar_event', db.database),
    ).toEqual({
      hasCoParent: true,
      coParentConsentGranted: false,
    });
    expect(
      await loadCrossParentConsent(fam.familyId, 'share_photos_with_family', db.database),
    ).toEqual({ hasCoParent: true, coParentConsentGranted: false });

    // Positive control: a grant for that kind, under the co-parent, in this family.
    await grantOptIn(fam.familyId, coParentId, 'create_calendar_event', new Date());
    expect(
      await loadCrossParentConsent(fam.familyId, 'create_calendar_event', db.database),
    ).toEqual({
      hasCoParent: true,
      coParentConsentGranted: true,
    });
    expect(
      await loadCrossParentConsent(fam.familyId, 'share_photos_with_family', db.database),
    ).toEqual({ hasCoParent: true, coParentConsentGranted: false });
  });

  it('a switch-off of the kind ends it; a household with no co-parent has nothing to ask', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await grantOptIn(
      fam.familyId,
      coParentId,
      'create_calendar_event',
      new Date(Date.now() - HOUR_MS),
    );

    await switchOff(fam, 'create_calendar_event');

    expect(
      await loadCrossParentConsent(fam.familyId, 'create_calendar_event', db.database),
    ).toEqual({
      hasCoParent: true,
      coParentConsentGranted: false,
    });
    const single = await seedFamily(db.database);
    expect(
      await loadCrossParentConsent(single.familyId, 'create_calendar_event', db.database),
    ).toEqual({ hasCoParent: false, coParentConsentGranted: false });
  });
});

describe('a switch-off restarts the streak', () => {
  it('four approvals after it do not re-arm the kind; the fifth does', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(await armed(fam.familyId, 'send_email')).toBe(true);

    await switchOff(fam, 'send_email');
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
    expect(await streakReached(fam, 'send_email')).toBe(false);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    expect(await streakReached(fam, 'send_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);

    await approve(fam, 'send_email');
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
    expect((await autonomyConsentRows(fam.familyId)).map((row) => row.granted)).toEqual([
      true,
      false,
      true,
    ]);
    expect(await grantAuditRows(fam.familyId)).toHaveLength(2);
  });

  it('either parent’s switch-off turns the kind off for both, and leaves another kind armed', async () => {
    const fam = await seedFamily(db.database);
    const coParentId = await addMember(fam.familyId, 'co_parent');
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED);

    await switchOff(fam, 'send_email', coParentId);

    expect(await standing(fam.familyId, 'send_email')).toEqual(
      new Map([
        [fam.parentUserId, { streakReached: false, optedIn: false }],
        [coParentId, { streakReached: false, optedIn: false }],
      ]),
    );
    expect(await armed(fam.familyId, 'calendar_add')).toBe(true);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(await armed(fam.familyId, 'send_email')).toBe(true);
  });

  it('a switch-off made straight after arming reads as off', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);

    expect(await switchOff(fam, 'send_email')).toMatchObject({ outcome: 'revoked' });

    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
  });

  it('a grant and a switch-off stamped at the same instant read as off', async () => {
    const fam = await seedFamily(db.database);
    const instant = new Date(Date.now() - HOUR_MS);
    await grantOptIn(fam.familyId, fam.parentUserId, 'send_email', instant);
    await db.database.insert(schema.consentRecords).values({
      familyId: fam.familyId,
      userId: fam.parentUserId,
      consentType: 'autonomous_action_class',
      consentScope: 'send_email',
      granted: false,
      grantedAt: instant,
      policyVersion: POLICY_VERSION,
    });

    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
  });

  it('the turn-on text is delivered only when that grant’s send has left', async () => {
    const fam = await seedFamily(db.database);
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(false);

    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    const fifth = await approve(fam, 'send_email');
    if (!fifth.claimed || fifth.autonomy.outcome !== 'granted') {
      throw new Error('expected the fifth approval to grant');
    }
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(false);

    await db.database.insert(schema.channelMessages).values({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'autonomy_armed',
      templateKey: 'autonomy:armed',
      dedupeKey: null,
      status: 'suppressed_quiet_hours',
    });
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(false);

    await db.database.insert(schema.channelMessages).values({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'autonomy_armed',
      templateKey: 'autonomy:armed',
      dedupeKey: autonomyArmedDedupeKey(fifth.autonomy.consentRecordId),
      status: 'queued',
    });
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(true);
  });

  it('a turn-on covered by another text counts only after the sent audit', async () => {
    const fam = await seedFamily(db.database);
    await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED - 1);
    const fifth = await approve(fam, 'send_email');
    if (!fifth.claimed || fifth.autonomy.outcome !== 'granted') {
      throw new Error('expected the fifth approval to grant');
    }
    const key = autonomyArmedDedupeKey(fifth.autonomy.consentRecordId);
    await db.database.insert(schema.auditLog).values({
      familyId: fam.familyId,
      actor: 'system',
      actionTaken: 'autonomy_notice_covered',
      targetTable: 'channel_messages',
      targetId: '11111111-1111-4111-8111-111111111111',
      after: { dedupeKey: key },
    });
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(false);

    await db.database.insert(schema.auditLog).values({
      familyId: fam.familyId,
      actor: 'system',
      actionTaken: 'autonomy_armed_notice_sent',
      targetTable: 'channel_messages',
      targetId: '11111111-1111-4111-8111-111111111111',
      after: { dedupeKey: key, occasion: 'armed', actionType: 'send_email' },
    });
    expect(await autonomyTurnOnDelivered(fam.familyId, 'send_email', db.database)).toBe(true);
  });

  it('a grant withdrawn by its revoked_at stamp reads as off', async () => {
    const fam = await seedFamily(db.database);
    await grantOptIn(fam.familyId, fam.parentUserId, 'send_email', new Date(Date.now() - HOUR_MS));
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);

    await db.database
      .update(schema.consentRecords)
      .set({ revokedAt: new Date() })
      .where(eq(schema.consentRecords.familyId, fam.familyId));

    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
  });
});
