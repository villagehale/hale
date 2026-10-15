import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import type { ActionType } from '@hale/types';
import { loadAutonomyStanding } from '@hale/worker/memory-writer';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { productionChannelCoachPorts } from './runtime';
import { createTurnOfferLedger } from './tools';

/**
 * The switch-off, reached from a text (Barton, 2026-10-11): a parent tells Hale, in any
 * words, to stop doing a kind of action on its own, and the coach's model calls
 * `turn_off_autonomy`. Driven through `productionChannelCoachPorts` against real DDL, so
 * the ledger the orchestrator's opt-in reader reads is the one asserted on — a fake
 * revoke port could not show that.
 */

const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-11T15:00:00.000Z');
const PARENT_WORDS = 'please stop sending emails for me without asking';
const INTERPRETATION = 'The parent wants Hale to stop emailing on its own.';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function grant(familyId: string, userId: string, kind: string) {
  await db.database.insert(schema.consentRecords).values({
    familyId,
    userId,
    consentType: 'autonomous_action_class',
    consentScope: kind,
    granted: true,
    grantedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    policyVersion: 'test-policy',
  });
}

/** Whether any parent's grant for the kind is live, read by the orchestrator's own reader. */
async function optedIn(familyId: string, kind: ActionType) {
  return (await loadAutonomyStanding(familyId, kind, db.database)).some((parent) => parent.optedIn);
}

async function emailAutonomousFamily() {
  const fam = await seedFamily(db.database);
  await grant(fam.familyId, fam.parentUserId, 'send_email');
  await grant(fam.familyId, fam.parentUserId, 'reply_to_email');
  return fam;
}

async function addCaregiver(familyId: string) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `grandparent-${familyId}@example.test`, name: 'Caregiver' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seed: users insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'grandparent' });
  return user.id;
}

function productionPorts() {
  // Constructed, never called: the draft port builds its Anthropic client eagerly.
  vi.stubEnv('ANTHROPIC_API_KEY', 'not-used-by-this-test');
  vi.stubGlobal('fetch', async () => {
    throw new Error('autonomy-switch-off.pglite.test: this test makes no network calls');
  });
  return productionChannelCoachPorts(db.database);
}

function switchOffTool(
  ports: ReturnType<typeof productionPorts>,
  familyId: string,
  senderUserId: string,
) {
  const noop = () => {};
  const tool = ports
    .buildTools(
      {
        familyId,
        parentUserId: senderUserId,
        conversationId: CONVERSATION_ID,
        body: PARENT_WORDS,
        now: NOW,
        standingQuestions: [],
        audience: 'direct',
      },
      noop,
      noop,
      noop,
      noop,
      noop,
      createTurnOfferLedger(),
    )
    .find((candidate) => candidate.name === 'turn_off_autonomy');
  if (!tool) throw new Error('production buildTools registers no turn_off_autonomy');
  return tool;
}

async function revocations(familyId: string) {
  return db.database
    .select({
      userId: schema.consentRecords.userId,
      consentScope: schema.consentRecords.consentScope,
      granted: schema.consentRecords.granted,
      evidence: schema.consentRecords.evidence,
    })
    .from(schema.consentRecords)
    .where(
      and(eq(schema.consentRecords.familyId, familyId), eq(schema.consentRecords.granted, false)),
    );
}

describe('turn_off_autonomy, through the production ports', () => {
  it('is offered to the model only where Hale can act on its own', async () => {
    const ports = productionPorts();
    const autonomous = await emailAutonomousFamily();
    const observing = await seedFamily(db.database);

    const offered = await ports.loadSkill(autonomous.parentUserId, autonomous.familyId);
    const withheld = await ports.loadSkill(observing.parentUserId, observing.familyId);

    expect(offered.meta.tools).toContain('turn_off_autonomy');
    expect(withheld.meta.tools).not.toContain('turn_off_autonomy');
    expect(offered.instructions).toBe(withheld.instructions);
  });

  it("a parent's text turns each named kind off, keeps their words and Hale's reading, and audits it", async () => {
    const ports = productionPorts();
    const fam = await emailAutonomousFamily();
    await grant(fam.familyId, fam.parentUserId, 'calendar_add');
    const guardDeps: GuardDeps = ports.guardDeps;

    const result = await invokeTool(
      switchOffTool(ports, fam.familyId, fam.parentUserId),
      { kinds: ['send_email', 'reply_to_email'], interpretation: INTERPRETATION },
      { familyId: fam.familyId, actor: fam.parentUserId },
      guardDeps,
    );

    expect(result).toEqual({ outcome: 'revoked', kinds: ['send_email', 'reply_to_email'] });
    expect(await optedIn(fam.familyId, 'send_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'reply_to_email')).toBe(false);
    expect(await optedIn(fam.familyId, 'calendar_add')).toBe(true);

    const evidence = { parentWords: PARENT_WORDS, interpretation: INTERPRETATION };
    expect(
      (await revocations(fam.familyId)).sort((a, b) =>
        String(a.consentScope).localeCompare(String(b.consentScope)),
      ),
    ).toEqual([
      { userId: fam.parentUserId, consentScope: 'reply_to_email', granted: false, evidence },
      { userId: fam.parentUserId, consentScope: 'send_email', granted: false, evidence },
    ]);

    const audit = await db.database
      .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, fam.familyId),
          eq(schema.auditLog.actionTaken, 'autonomous_action_class.revoked'),
        ),
      );
    expect(audit).toHaveLength(2);
    expect(audit.every((row) => row.actor === fam.parentUserId)).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(PARENT_WORDS);
  });

  it('someone who is not a parent gets not_a_parent, and nothing is written', async () => {
    const ports = productionPorts();
    const fam = await emailAutonomousFamily();
    const caregiverId = await addCaregiver(fam.familyId);

    const result = await invokeTool(
      switchOffTool(ports, fam.familyId, caregiverId),
      { kinds: ['send_email'], interpretation: INTERPRETATION },
      { familyId: fam.familyId, actor: caregiverId },
      ports.guardDeps,
    );

    expect(result).toEqual({ outcome: 'not_a_parent' });
    expect(await revocations(fam.familyId)).toEqual([]);
    expect(await optedIn(fam.familyId, 'send_email')).toBe(true);
  });
});
