import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type GroupPlan,
  type GroupPlanFamily,
  attendanceFromAnswer,
  attendanceUserMessage,
  createFamilyEventsCopyStore,
} from './group-plan-invites';

// What the attendance read decides is the eval's job (run-group-plan-invites-eval.mjs).
// These tests cover only what code owns.

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamilies(n: number): Promise<GroupPlanFamily[]> {
  const out: GroupPlanFamily[] = [];
  for (let i = 0; i < n; i += 1) {
    const [f] = await db.database
      .insert(schema.families)
      .values({ displayName: `Fam${i}`, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    out.push({ familyId: f?.id as string, label: `Fam${i}`, memberFirstNames: [`P${i}`] });
  }
  return out;
}

const PLAN: GroupPlan = {
  groupPlanId: 'plan-1',
  chatId: 'chat-g',
  title: 'Park playdate',
  startsAt: new Date('2026-11-07T15:00:00Z'),
  endsAt: new Date('2026-11-07T17:00:00Z'),
  location: 'Riverdale Park',
  cancelled: false,
};

const liveCopies = async (familyId: string) =>
  db.database.select().from(schema.familyEvents).where(eq(schema.familyEvents.familyId, familyId));

describe('VIL-455 per-family copy store', () => {
  it('a re-write with nothing changed is unchanged and keeps one copy', async () => {
    const [fam] = await seedFamilies(1);
    const familyId = fam?.familyId as string;
    const copies = createFamilyEventsCopyStore(db.database);
    const first = await copies.upsertCopy(PLAN, familyId);
    const again = await copies.upsertCopy(PLAN, familyId);
    expect(first.status).toBe('written');
    expect(again).toEqual({ status: 'unchanged', familyEventId: first.familyEventId });
    expect(await liveCopies(familyId)).toHaveLength(1);
  });

  it('the key is scoped to the group plan: a second plan gets its own copy', async () => {
    const [fam] = await seedFamilies(1);
    const familyId = fam?.familyId as string;
    const copies = createFamilyEventsCopyStore(db.database);
    await copies.upsertCopy(PLAN, familyId);
    await copies.upsertCopy({ ...PLAN, groupPlanId: 'plan-2' }, familyId);
    expect(await liveCopies(familyId)).toHaveLength(2);
  });

  it('an edit moves the same copy', async () => {
    const [fam] = await seedFamilies(1);
    const familyId = fam?.familyId as string;
    const copies = createFamilyEventsCopyStore(db.database);
    const first = await copies.upsertCopy(PLAN, familyId);
    const moved = await copies.upsertCopy(
      { ...PLAN, startsAt: new Date('2026-11-08T15:00:00Z'), endsAt: null },
      familyId,
    );
    expect(moved).toEqual({ status: 'written', familyEventId: first.familyEventId });
    const rows = await liveCopies(familyId);
    expect(rows.map((row) => row.startsAt.toISOString())).toEqual(['2026-11-08T15:00:00.000Z']);
  });

  it('a cancel soft-deletes the copy, and a family with no copy has nothing to cancel', async () => {
    const [fam, other] = await seedFamilies(2);
    const familyId = fam?.familyId as string;
    const copies = createFamilyEventsCopyStore(db.database);
    const first = await copies.upsertCopy(PLAN, familyId);
    expect(await copies.cancelCopy(PLAN, familyId)).toBe(first.familyEventId);
    expect((await liveCopies(familyId))[0]?.deletedAt).not.toBeNull();
    expect(await copies.cancelCopy(PLAN, other?.familyId as string)).toBeNull();
  });
});

describe('VIL-455 attendance request shape', () => {
  const fams: GroupPlanFamily[] = [
    { familyId: 'uuid-a', label: 'Lee', memberFirstNames: ['Ana'] },
    { familyId: 'uuid-b', label: 'Dong', memberFirstNames: ['Barton'] },
  ];

  it('never shows the model a family id', () => {
    const msg = attendanceUserMessage({
      plan: PLAN,
      families: fams,
      messages: [{ familyId: 'uuid-a', senderName: 'Ana', text: 'x' }],
    });
    expect(msg).not.toContain('uuid-');
  });

  it('rejects an answer that skips or invents a family key', () => {
    expect(attendanceFromAnswer(fams, { families: [{ key: 'f1', attendance: 'in' }] })).toBeNull();
    expect(
      attendanceFromAnswer(fams, {
        families: [
          { key: 'f1', attendance: 'in' },
          { key: 'f9', attendance: 'in' },
        ],
      }),
    ).toBeNull();
    expect(
      attendanceFromAnswer(fams, {
        families: [
          { key: 'f1', attendance: 'in' },
          { key: 'f2', attendance: 'out' },
        ],
      })?.get('uuid-b'),
    ).toBe('out');
  });
});
