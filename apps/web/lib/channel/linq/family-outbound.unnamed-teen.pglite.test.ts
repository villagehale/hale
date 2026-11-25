import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { queueGroupActivityDecision } from './family-outbound';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. A 1:1 pick that a 13+ child with no name could own is never queued
 * for the group.
 *
 * The live participant read fails here (no Linq is called), which the queue treats as
 * "still waiting": the row is queued for a later flush, so a queued row is what a group
 * would later hear.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
const NOW = new Date('2026-09-24T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('unavailable', { status: 503 })),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function household(children: ReadonlyArray<{ name: string | null; years: number }>) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household', provinceOrState: 'ON', linqGroupChatId: 'chat-home' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: 'Test Parent' })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: 'chat-home', familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  await db.database.insert(schema.linqGroupRosterMembers).values([
    {
      rosterId: roster?.id as string,
      chatId: 'chat-home',
      phoneE164Hash: 'opaque-parent',
      status: 'known_parent',
    },
    {
      rosterId: roster?.id as string,
      chatId: 'chat-home',
      phoneE164Hash: 'opaque-coparent',
      status: 'confirmed',
      confirmedRole: 'co_parent',
    },
  ]);
  for (const child of children) {
    const born = new Date(NOW);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  const pick = (activity: string, kid: string) =>
    queueGroupActivityDecision(db.database, {
      familyId,
      parentUserId,
      originChatId: 'chat-one-to-one',
      decision: { decision: 'picked', activity, kid, day: 'Monday', time: '6:00' },
      now: NOW,
    });
  const queued = async () =>
    (
      await db.database
        .select({ activity: schema.groupDecisionSync.activity })
        .from(schema.groupDecisionSync)
        .where(eq(schema.groupDecisionSync.familyId, familyId))
    ).map((row) => row.activity);
  return { pick, queued };
}

describe('group decision sync · a teenager with no name on file (rule #1)', () => {
  it('an unnamed only child of 14: the pick is not queued', async () => {
    const home = await household([{ name: null, years: 14 }]);
    expect(await home.pick('hockey', 'my oldest')).toBe('skipped');
    expect(await home.queued()).toEqual([]);
  });

  it('a named 14-year-old who is the only child: the pick is not queued', async () => {
    const home = await household([{ name: 'Noor', years: 14 }]);
    expect(await home.pick('hockey', 'Noor')).toBe('skipped');
    expect(await home.queued()).toEqual([]);
  });

  it("positive control: a named 8-year-old's pick is queued", async () => {
    const home = await household([{ name: 'Maya', years: 8 }]);
    expect(await home.pick('swim', 'Maya')).toBe('queued');
    expect(await home.queued()).toEqual(['swim']);
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's pick is held, the 8-year-old's is queued", async () => {
    const home = await household([
      { name: 'Maya', years: 8 },
      { name: null, years: 15 },
    ]);
    expect(await home.pick('hockey', 'my oldest')).toBe('skipped');
    expect(await home.pick('swim', 'Maya')).toBe('queued');
    expect(await home.queued()).toEqual(['swim']);
  });
});
