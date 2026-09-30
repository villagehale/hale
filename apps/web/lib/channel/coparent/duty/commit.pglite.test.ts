import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeLogisticsDecision } from '~/lib/channel/linq/logistics-poll';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { DUTY_BOTH_CLAIMED_COPY, DUTY_WHICH_KID_COPY } from './copy';
import { commitDutyRemoval, commitDutyUpdate, loadReadableDuties } from './model';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function secondParent(familyId: string, name: string): Promise<string> {
  const email = `${name}-${familyId}@example.test`;
  const inserted = (await db.database.execute(
    sql`insert into users (email, name) values (${email}, ${name}) returning id`,
  )) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
  const user = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
  if (!user) throw new Error('second parent insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

describe('commitDutyUpdate', () => {
  it('writes one live fact per role, one audit row each, and overwrites on removal', async () => {
    const family = await seedFamily(db.database, 'Duty');
    const sam = await secondParent(family.familyId, 'Sam');
    const now = new Date('2026-09-29T15:00:00.000Z');
    const subjectKey = 'who-takes/2026-09-29T19:00:00.000Z/maya%20swim';
    const base = {
      mode: 'write' as const,
      familyId: family.familyId,
      parentCount: 2,
      subjectKey,
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      source: 'text' as const,
      now,
      childId: null,
      question: false,
      askWhichKid: false,
    };
    const pickup = await commitDutyUpdate(db.database, {
      ...base,
      actorUserId: family.parentUserId,
      slot: {
        role: 'pickup',
        claim: 'self',
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
    });
    const dropoff = await commitDutyUpdate(db.database, {
      ...base,
      actorUserId: sam,
      slot: { role: 'dropoff', claim: 'named', name: 'Grandma', userId: null, confidence: 1 },
      prior: null,
    });
    expect(pickup.written).toBe(true);
    expect(pickup.sent).toBe(false);
    expect(dropoff.written).toBe(true);
    const again = await commitDutyUpdate(db.database, {
      ...base,
      actorUserId: sam,
      slot: { role: 'pickup', claim: 'self', name: null, userId: sam, confidence: 1 },
      prior: pickup.state,
    });
    expect(again.state?.status).toBe('conflict');
    expect(again.state?.owner).toBeNull();
    expect(again.ask).toBe(DUTY_BOTH_CLAIMED_COPY);
    expect(again.sent).toBe(false);

    const live = await loadReadableDuties(db.database, family.familyId);
    const pickupRows = live.filter((row) => row.role === 'pickup');
    const dropoffRows = live.filter((row) => row.role === 'dropoff');
    expect(pickupRows).toHaveLength(1);
    expect(dropoffRows).toHaveLength(1);
    expect(pickupRows[0]?.status).toBe('conflict');
    expect(dropoffRows[0]?.ownerName).toBe('Grandma');

    expect(again.state).not.toBeNull();
    expect(pickup.factKey).toBeTruthy();
    const removed = await commitDutyRemoval(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: sam,
      parentCount: 2,
      prior: again.state as NonNullable<typeof again.state>,
      factKey: pickup.factKey as string,
      now,
      childId: null,
    });
    expect(removed.written).toBe(true);
    const after = await loadReadableDuties(db.database, family.familyId);
    expect(after.filter((row) => row.role === 'pickup')).toHaveLength(1);

    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog);
    const dutyAudits = audits.filter((row) => row.actionTaken === 'logistics_decision_recorded');
    expect(dutyAudits.length).toBeGreaterThanOrEqual(4);
  });

  it('does not write a question, a low-confidence slot, a which-kid ask, a shadow plan, or a single parent', async () => {
    const family = await seedFamily(db.database, 'Quiet');
    const now = new Date('2026-09-29T15:00:00.000Z');
    const subjectKey = 'who-takes/2026-09-29T19:00:00.000Z/swim%20class';
    const common = {
      familyId: family.familyId,
      actorUserId: family.parentUserId,
      subjectKey,
      eventTitle: 'swim class',
      childNames: ['Maya', 'Leo'],
      slot: {
        role: 'attend' as const,
        claim: 'self' as const,
        name: null,
        userId: family.parentUserId,
        confidence: 1,
      },
      prior: null,
      source: 'text' as const,
      now,
      childId: null,
    };
    const question = await commitDutyUpdate(db.database, {
      ...common,
      mode: 'write',
      parentCount: 2,
      question: true,
      askWhichKid: false,
    });
    const low = await commitDutyUpdate(db.database, {
      ...common,
      mode: 'write',
      parentCount: 2,
      question: false,
      askWhichKid: false,
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
      slot: { ...common.slot, confidence: 0.4 },
    });
    const which = await commitDutyUpdate(db.database, {
      ...common,
      mode: 'write',
      parentCount: 2,
      question: false,
      askWhichKid: true,
    });
    const shadow = await commitDutyUpdate(db.database, {
      ...common,
      mode: 'shadow',
      parentCount: 2,
      question: false,
      askWhichKid: false,
      eventTitle: 'Maya swim',
      childNames: ['Maya'],
    });
    const single = await commitDutyUpdate(db.database, {
      ...common,
      mode: 'write',
      parentCount: 1,
      question: false,
      askWhichKid: false,
    });
    expect(question).toMatchObject({ written: false, reason: 'question', sent: false });
    expect(low).toMatchObject({ written: false, reason: 'low_confidence', sent: false });
    expect(which).toMatchObject({ written: false, reason: 'which_kid', ask: DUTY_WHICH_KID_COPY });
    expect(shadow).toMatchObject({ written: false, reason: 'shadow', sent: false });
    expect(single).toMatchObject({ written: false, reason: 'single_parent' });
    expect(await loadReadableDuties(db.database, family.familyId)).toEqual([]);
  });

  it('keeps a legacy who-takes row readable and does not copy a non-kid title', async () => {
    const family = await seedFamily(db.database, 'Legacy');
    const sam = await secondParent(family.familyId, 'Sam');
    const now = new Date('2026-09-29T15:00:00.000Z');
    const legacyKey = 'who-takes/2026-09-29T19:00:00.000Z/maya%20gymnastics';
    await writeLogisticsDecision(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      factKey: legacyKey,
      childId: null,
      now,
      value: {
        kind: 'who_takes',
        status: 'decided',
        startIso: '2026-09-29T19:00:00.000Z',
        titleNorm: 'maya gymnastics',
        takerUserId: family.parentUserId,
        slotLabel: null,
        slotStart: null,
        kid: 'Maya',
        event: 'gymnastics',
        day: null,
        slots: [],
        source: 'poll',
      },
    });
    const offsite = 'who-takes/2026-09-29T20:00:00.000Z/team%20offsite';
    await commitDutyUpdate(db.database, {
      mode: 'write',
      familyId: family.familyId,
      actorUserId: sam,
      parentCount: 2,
      subjectKey: offsite,
      eventTitle: 'team offsite',
      childNames: ['Maya'],
      slot: { role: 'attend', claim: 'self', name: null, userId: sam, confidence: 1 },
      prior: null,
      source: 'poll',
      now,
      childId: null,
      question: false,
      askWhichKid: false,
    });
    const readable = await loadReadableDuties(db.database, family.familyId);
    expect(readable.some((row) => row.legacy && row.factKey === legacyKey)).toBe(true);
    const duty = readable.find((row) => row.role === 'attend');
    expect(duty?.legacy).toBe(false);
    expect(JSON.stringify(duty)).not.toContain('offsite');
    expect(JSON.stringify(duty)).not.toContain('team offsite');
  });
});
