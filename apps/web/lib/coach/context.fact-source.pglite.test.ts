import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { loadAgentContext } from './context';

/**
 * VIL-429 · a fact the coach is handed from Gmail or Calendar says where Hale saw it, so
 * a reply that uses it can say so. A reader who may not hear the source is not handed
 * the fact at all.
 */

const NOW = new Date('2026-10-09T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function load(familyId: string, readerUserId?: string) {
  return loadAgentContext(
    {
      familyId,
      question: 'what is on this week?',
      intent: null,
      focusedChildId: null,
      transcript: [],
      sourceNote: null,
      ...(readerUserId ? { readerUserId } : {}),
    },
    db.database,
    NOW,
  );
}

async function seedSourcedFamily() {
  const { familyId, parentUserId } = await seedFamily(db.database);
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/New_York' })
    .where(eq(schema.users.id, parentUserId));
  await seedIntegration(db.database, familyId, parentUserId, 'gmail');
  const [mail, event] = await db.database
    .insert(schema.events)
    .values([
      {
        familyId,
        source: 'gmail',
        eventType: 'activity_signup_open',
        payload: { sender: 'Northside Rec <programs@northside-rec.example>', subject: 'SECRET' },
        dedupHash: `mail-${familyId}`,
        // 01:00 UTC on Oct 4 is still Oct 3 in New York.
        receivedAt: new Date('2026-10-04T01:00:00.000Z'),
      },
      {
        familyId,
        source: 'gcal',
        eventType: 'unclassified',
        payload: { summary: 'Soccer practice', start: { date: '2026-10-02' } },
        dedupHash: `cal-${familyId}`,
      },
    ])
    .returning({ id: schema.events.id });
  const fact = (factKey: string, sourceEventId: string | null) => ({
    familyId,
    childId: null,
    factType: 'routine' as const,
    factKey,
    factValue: 'Thursdays',
    confidence: 0.9,
    inferredBy: 'memory_inferencer',
    sourceEventId,
    memorySource: 'inferred',
  });
  await db.database
    .insert(schema.familyMemoryFacts)
    .values([
      fact('from_mail', mail?.id ?? null),
      fact('from_calendar', event?.id ?? null),
      fact('said_plainly', null),
    ]);
  const [coParent] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Other Parent' })
    .returning({ id: schema.users.id });
  if (!coParent) throw new Error('user insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParent.id, role: 'co_parent' });
  return { familyId, parentUserId, coParentId: coParent.id };
}

function byKey(facts: Awaited<ReturnType<typeof load>>['memoryFacts']) {
  return Object.fromEntries(facts.map((fact) => [fact.factKey, fact]));
}

describe('coach context — where a connector fact was seen', () => {
  it('hands the mailbox owner the sender and day, and an event its title and day', async () => {
    const { familyId, parentUserId } = await seedSourcedFamily();
    const facts = byKey((await load(familyId, parentUserId)).memoryFacts);
    expect(facts.from_mail?.seenIn).toEqual({
      email: { from: 'Northside Rec', on: '2026-10-03' },
    });
    expect(facts.from_calendar?.seenIn).toEqual({
      calendar: { title: 'Soccer practice', on: '2026-10-02' },
    });
    expect(facts.said_plainly).not.toHaveProperty('seenIn');
    expect(JSON.stringify(facts)).not.toContain('SECRET');
  });

  it('leaves the email fact out for the other parent, and for an unnamed reader', async () => {
    const { familyId, coParentId } = await seedSourcedFamily();
    for (const reader of [coParentId, undefined]) {
      const facts = byKey((await load(familyId, reader)).memoryFacts);
      expect(Object.keys(facts).sort()).toEqual(['from_calendar', 'said_plainly']);
    }
  });
});
