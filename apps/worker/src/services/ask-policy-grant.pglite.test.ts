import { schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTONOMY_STREAK_REQUIRED } from '../orchestrator/autonomy-gate.js';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import { recordExecution, recordHumanApproval } from './memory-writer.js';

/**
 * VIL-719 · the grant writer under the ask policy, against real DDL. An ask-first kind is
 * never granted, however many approvals in a row, so no turn-on text can promise Hale will
 * do it on its own; a tell-after kind still arms on the fifth approval. Off, the ledger is
 * exactly what it was.
 */

const POLICY_VERSION = 'test-policy';

let db: TestDb;
let sequence = 0;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function approve(fam: SeededFamily, kind: ActionType) {
  sequence += 1;
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: fam.familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: `ask-policy-${sequence}`,
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
      payload: { to: 'school@example.test', subject: 'hi', body: 'drafted words' },
      reviewerVerdict: 'approved',
    })
    .returning({ id: schema.actions.id });
  if (!action) throw new Error('seed: actions insert returned no row');
  const claim = await recordHumanApproval(
    {
      familyId: fam.familyId,
      eventId: event.id,
      actionId: action.id,
      approvedBy: fam.parentUserId,
      policyVersion: POLICY_VERSION,
    },
    db.database,
  );
  await recordExecution(
    {
      actionId: action.id,
      result: { kind: 'test' },
      ok: true,
      decision: { source: 'human', reason: 'a parent approved it' },
    },
    db.database,
  );
  return claim;
}

async function approveTimes(fam: SeededFamily, kind: ActionType, times: number) {
  const claims = [];
  for (let i = 0; i < times; i += 1) claims.push(await approve(fam, kind));
  return claims;
}

async function grants(familyId: string) {
  const rows = await db.database
    .select({ scope: schema.consentRecords.consentScope })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
      ),
    );
  return rows.map((row) => row.scope);
}

async function grantAudits(familyId: string) {
  return db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'autonomous_action_class.granted'),
      ),
    );
}

async function approvalAudits(familyId: string) {
  return db.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'action.approved_by_human'),
      ),
    );
}

describe('policy on', () => {
  it.each(['send_email', 'reply_to_email'] as const)(
    'every approval of %s is recorded, and none of them, not even the fifth, writes a grant',
    async (kind) => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const fam = await seedFamily(db.database);
      const claims = await approveTimes(fam, kind, AUTONOMY_STREAK_REQUIRED + 1);
      expect(claims).toEqual(
        claims.map(() => ({ claimed: true, autonomy: { outcome: 'ask_first' } })),
      );
      expect(await approvalAudits(fam.familyId)).toHaveLength(AUTONOMY_STREAK_REQUIRED + 1);
      expect(await grants(fam.familyId)).toEqual([]);
      expect(await grantAudits(fam.familyId)).toEqual([]);
    },
  );

  it('a tell-after kind still arms on the fifth approval', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const claims = await approveTimes(fam, 'calendar_add', AUTONOMY_STREAK_REQUIRED);
    expect(claims.slice(0, -1)).toEqual(
      claims.slice(0, -1).map(() => ({ claimed: true, autonomy: { outcome: 'not_reached' } })),
    );
    expect(claims.at(-1)).toEqual({
      claimed: true,
      autonomy: { outcome: 'granted', consentRecordId: expect.any(String) },
    });
    expect(await grants(fam.familyId)).toEqual(['calendar_add']);
  });

  it('a never-autonomous kind keeps its own outcome', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const [claim] = await approveTimes(fam, 'book_clinic_portal', 1);
    expect(claim).toEqual({ claimed: true, autonomy: { outcome: 'denied_kind' } });
  });
});

describe('policy off', () => {
  it('the fifth send_email approval writes its grant, as before', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const fam = await seedFamily(db.database);
    const claims = await approveTimes(fam, 'send_email', AUTONOMY_STREAK_REQUIRED);
    expect(claims.at(-1)).toEqual({
      claimed: true,
      autonomy: { outcome: 'granted', consentRecordId: expect.any(String) },
    });
    expect(await grants(fam.familyId)).toEqual(['send_email']);
    expect(await grantAudits(fam.familyId)).toHaveLength(1);
  });
});
