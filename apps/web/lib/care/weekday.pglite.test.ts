import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadAgentContext } from '~/lib/coach/context';
import { readCandidates } from '~/lib/channel/intake/radar';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  WEEKDAY_CARE_FACT_KEY,
  WEEKDAY_CARE_FACT_WRITER,
  loadWeekdayCare,
  recordWeekdayCare,
} from './weekday';

/**
 * The two READS the weekday legs rest on, against real Postgres and through the
 * production functions — because both are the kind of claim a hand-rolled Drizzle
 * fake cannot make.
 *
 * `loadWeekdayCare`'s whole safety property is a WHERE clause: `family_memory_facts`
 * is writable by the app coach's `save_memory` tool under any key a model likes, so a
 * reader that matched only the key would let one injected sentence change what Hale
 * offers a household for months. A fake returns whatever rows it was handed and would
 * pass with the pin removed.
 *
 * `readCandidates` is here for the sibling reason (the "pin production wiring" rule):
 * the weekday claim rests on `village_candidates.source`, and a column the reader does
 * not SELECT is a gate that silently always fails. The decide's own suite cannot see
 * that, because it is handed candidates directly.
 */

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

const NOW = new Date('2026-09-14T14:00:00.000Z');

let seq = 0;

async function seedFamily(): Promise<{
  familyId: string;
  childId: string;
  parentUserId: string;
}> {
  seq += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:care-${seq}`, name: 'Ana', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2024-03-02' })
    .returning({ id: schema.children.id });
  return { familyId, childId: child?.id as string, parentUserId };
}

describe('loadWeekdayCare', () => {
  it('returns the live fact this feature wrote, with its care and its provider', async () => {
    const { familyId, childId } = await seedFamily();
    await writeFact(db.database, {
      familyId,
      childId,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'daycare', provider: 'Little Sprouts' },
      confidence: 1,
      inferredBy: WEEKDAY_CARE_FACT_WRITER,
      validFrom: NOW,
    });

    expect(await loadWeekdayCare(db.database, familyId)).toEqual([
      { childId, care: 'daycare', provider: 'Little Sprouts', validFrom: NOW },
    ]);
  });

  /**
   * THE WRITER PIN, with its decoy beside it. `ask-hale` is the app coach's memory
   * tool, which chooses its own `fact_key` from a model's output — so the decoy row
   * here is a row a single injected sentence could really produce.
   */
  it('is blind to a row written under the same key by the app coach', async () => {
    const { familyId, childId } = await seedFamily();
    const [other] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Leo', dateOfBirth: '2022-05-09' })
      .returning({ id: schema.children.id });
    // The decoy: same family, same key, a DIFFERENT child so the partial unique index
    // lets both live at once — exactly the state an injection would leave behind.
    await writeFact(db.database, {
      familyId,
      childId: other?.id as string,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'daycare', provider: null },
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId,
      childId,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'home', provider: null },
      confidence: 1,
      inferredBy: WEEKDAY_CARE_FACT_WRITER,
      validFrom: NOW,
    });

    const live = await loadWeekdayCare(db.database, familyId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ childId, care: 'home' });
  });

  it('is blind to a superseded fact — only what is true now', async () => {
    const { familyId, childId } = await seedFamily();
    const write = (care: string, validFrom: Date) =>
      writeFact(db.database, {
        familyId,
        childId,
        factType: 'logistic',
        factKey: WEEKDAY_CARE_FACT_KEY,
        factValue: { care, provider: null },
        confidence: 1,
        inferredBy: WEEKDAY_CARE_FACT_WRITER,
        validFrom,
      });
    await write('home', NOW);
    await write('daycare', new Date(NOW.getTime() + 86_400_000));

    const live = await loadWeekdayCare(db.database, familyId);
    expect(live).toHaveLength(1);
    expect(live[0]?.care).toBe('daycare');
  });

  it('has nothing to say about a household that has never answered', async () => {
    const { familyId } = await seedFamily();
    expect(await loadWeekdayCare(db.database, familyId)).toEqual([]);
  });
});

describe('readCandidates — the column the weekday claim rests on', () => {
  it('carries `source` through, so a civic row can be told from an LLM one', async () => {
    const { familyId } = await seedFamily();
    await db.database.insert(schema.villageCandidates).values([
      {
        familyId,
        title: 'EarlyON drop-in',
        kind: 'drop_in',
        summary: 'Free drop-in at Armour Heights - 9:30 a.m.-11:00 a.m.',
        source: CIVIC_SOURCE,
        runType: 'civic',
        eventDate: '2026-09-15',
        confidence: 0.9,
      },
      {
        familyId,
        title: 'Music circle',
        kind: 'class',
        summary: 'A weekly music circle nearby.',
        source: 'llm',
        runType: 'standing',
        eventDate: '2026-09-15',
        confidence: 0.9,
      },
    ]);

    const rows = await readCandidates(db.database, familyId);
    expect(rows.map((row) => row.source).sort()).toEqual([CIVIC_SOURCE, 'llm']);
  });
});

describe('recordWeekdayCare', () => {
  const NOW_LATER = new Date(NOW.getTime() + 86_400_000);

  async function facts(familyId: string) {
    return db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
  }

  async function audits(familyId: string) {
    return db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
  }

  it('writes one fact and one audit row', async () => {
    const { familyId, childId, parentUserId } = await seedFamily();

    const outcome = await recordWeekdayCare(db.database, {
      familyId,
      parentUserId,
      childId,
      care: 'daycare',
      provider: 'Little Sprouts',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'recorded', care: 'daycare', providerNamed: true });
    expect(await loadWeekdayCare(db.database, familyId)).toEqual([
      { childId, care: 'daycare', provider: 'Little Sprouts', validFrom: NOW },
    ]);
    const trail = await audits(familyId);
    expect(trail).toHaveLength(1);
    expect(trail[0]?.actionTaken).toBe('weekday_care_recorded');
    expect(trail[0]?.targetTable).toBe('family_memory_facts');
    expect(trail[0]?.targetId).toBe(familyId);
  });

  /**
   * ONE TRANSACTION, proved from the side that can actually fail. The audit row is
   * written FIRST, so the thing that must not survive on its own is the audit: a trail
   * entry saying a parent told Hale something, with no fact behind it, is a receipt for
   * a state change that did not happen.
   */
  it('leaves no audit row behind when the fact write fails', async () => {
    const { familyId, parentUserId } = await seedFamily();

    await expect(
      recordWeekdayCare(db.database, {
        familyId,
        parentUserId,
        // A child id no row holds: `family_memory_facts.child_id` refuses it, inside the
        // transaction the audit row was already written in.
        childId: '00000000-0000-0000-0000-0000000000ff',
        care: 'home',
        provider: null,
        now: NOW,
      }),
    ).rejects.toThrow();

    expect(await audits(familyId)).toEqual([]);
    expect(await facts(familyId)).toEqual([]);
  });

  it('supersedes the first answer, with a followable chain', async () => {
    const { familyId, childId, parentUserId } = await seedFamily();
    const write = (care: 'home' | 'daycare', now: Date) =>
      recordWeekdayCare(db.database, {
        familyId,
        parentUserId,
        childId,
        care,
        provider: null,
        now,
      });

    await write('home', NOW);
    await write('daycare', NOW_LATER);

    const rows = await facts(familyId);
    expect(rows).toHaveLength(2);
    const closed = rows.find((row) => row.validUntil !== null);
    const live = rows.find((row) => row.validUntil === null);
    expect(closed?.validUntil).toEqual(NOW_LATER);
    expect(closed?.supersededBy).toBe(live?.id);
    expect(live?.factValue).toEqual({ care: 'daycare', provider: null });
  });

  /**
   * The provider may be a person's name ("at Nana's"), so the trail carries a BOOLEAN
   * and the string stays in the one family-scoped fact row. Asserted against the
   * serialised payload, with a positive control beside it because an absence test that
   * looked at the wrong object would pass just as happily.
   */
  it('keeps the provider and the child name out of the trail', async () => {
    const { familyId, childId, parentUserId } = await seedFamily();

    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId,
      childId,
      care: 'daycare',
      provider: 'Little Sprouts',
      now: NOW,
    });

    const after = JSON.stringify((await audits(familyId))[0]?.after);
    expect(after).not.toContain('Little Sprouts');
    expect(after).not.toContain('Mia');
    expect(after).not.toContain(childId);
    // The positive control: the STATE is there, which is the whole point of the row.
    expect(JSON.parse(after)).toEqual({
      care: 'daycare',
      providerNamed: true,
      source: 'sms_reply',
    });
  });

  /**
   * Nothing in this feature can write a fact for a 13+ child - the ask never names one -
   * but the table is shared, so the redaction that guards the coach is asserted here
   * against a row only a direct call could produce.
   */
  it("is redacted from the coach when the child is 13+, key and value both", async () => {
    const { familyId, parentUserId } = await seedFamily();
    const [teen] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Ava', dateOfBirth: '2011-03-04' })
      .returning({ id: schema.children.id });

    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId,
      childId: teen?.id as string,
      care: 'daycare',
      provider: 'Little Sprouts',
      now: NOW,
    });

    const context = await loadAgentContext(
      {
        familyId,
        question: 'what is going on this week',
        intent: null,
        focusedChildId: teen?.id as string,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );

    const serialised = JSON.stringify(context.memoryFacts);
    expect(serialised).not.toContain('Little Sprouts');
    expect(serialised).not.toContain(WEEKDAY_CARE_FACT_KEY);
  });
});
