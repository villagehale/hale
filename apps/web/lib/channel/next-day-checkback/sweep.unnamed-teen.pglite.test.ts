import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { childNameForStorage } from '~/lib/channel/intake/provision';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { queueCheckInForDecider } from '~/lib/channel/proactive/queue';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { NEXT_DAY_CHECKBACK_ENABLED_ENV } from './flag';
import { type NextDayCheckbackDeps, runNextDayCheckbackSweep } from './sweep';

/**
 * Rule #1 · with STATED_CHILD_NAME_ENABLED on, intake stores no name for a child the
 * parent never named. The next-day check-back treats a 13+ child with no name as a teen:
 * a thread that could be theirs is not checked back on, so its title never leaves.
 */

const STATED_CHILD_NAME_ENABLED_ENV = 'STATED_CHILD_NAME_ENABLED';
const ET = 'America/New_York';
const ANCHOR = new Date('2026-11-11T03:40:00.000Z');
const NOW = new Date('2026-11-11T13:17:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(NEXT_DAY_CHECKBACK_ENABLED_ENV, 'true');
  vi.stubEnv('WORKSTREAMS_ENABLED', 'true');
  vi.stubEnv(STATED_CHILD_NAME_ENABLED_ENV, 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

const deps: NextDayCheckbackDeps = {
  buildGate: (): OutboundGatePorts => ({
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => true,
    parentTimeZone: async () => ET,
  }),
  queueCandidate: queueCheckInForDecider,
  f14For: () => true,
};

async function household(
  children: ReadonlyArray<{ name: string | null; years: number }>,
  titles: ReadonlyArray<string | { title: string; nextStep: string }>,
): Promise<string> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Test household', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [parent] = await db.database
    .insert(schema.users)
    .values({ name: 'Primary', timezone: ET })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  for (const child of children) {
    const born = new Date(NOW);
    born.setFullYear(born.getFullYear() - child.years);
    await db.database.insert(schema.children).values({
      familyId,
      name: childNameForStorage(child.name),
      dateOfBirth: born.toISOString().slice(0, 10),
    });
  }
  for (const thread of titles) {
    const { title, nextStep } =
      typeof thread === 'string'
        ? { title: thread, nextStep: 'Pick one of the three sessions' }
        : thread;
    const [ask] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'can you look into this?',
        createdAt: new Date(ANCHOR.getTime() - 60_000),
      })
      .returning({ id: schema.channelMessages.id });
    await db.database.insert(schema.familyWorkstreams).values({
      familyId,
      title,
      status: 'waiting_on_parent',
      nextStep,
      checkBackAt: null,
      childIds: [],
      createdFrom: ask?.id as string,
      updatedFrom: ask?.id as string,
      createdAt: ANCHOR,
      updatedAt: ANCHOR,
      expiresAt: new Date(ANCHOR.getTime() + 14 * 86_400_000),
      lastFollowedUpAt: null,
    });
  }
  return familyId;
}

async function queuedText(familyId: string): Promise<string> {
  const rows = await db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId));
  return JSON.stringify(rows);
}

describe('next-day check-back · a teenager with no name on file (rule #1)', () => {
  it('an unnamed only child of 14: the thread is teen-scoped and its title is not queued', async () => {
    const familyId = await household([{ name: null, years: 14 }], ['Driving lessons this winter']);
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps);
    expect(result).toMatchObject({ teenScoped: 1, queued: 0 });
    expect(await queuedText(familyId)).not.toMatch(/driving/i);
  });

  it('a named 14-year-old who is the only child is scoped the same way', async () => {
    const familyId = await household(
      [{ name: 'Morgan', years: 14 }],
      ['Driving lessons this winter'],
    );
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps);
    expect(result).toMatchObject({ teenScoped: 1, queued: 0 });
    expect(await queuedText(familyId)).not.toMatch(/driving/i);
  });

  it("positive control: a named 8-year-old's thread is still checked back on, title and all", async () => {
    const familyId = await household([{ name: 'Robin', years: 8 }], ['Fall swim registration']);
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps);
    expect(result).toMatchObject({ teenScoped: 0, queued: 1 });
    expect(await queuedText(familyId)).toContain('Fall swim registration');
  });

  it("a named 8-year-old and an unnamed 15-year-old: the teen's thread is scoped, the 8-year-old's is queued", async () => {
    const familyId = await household(
      [
        { name: 'Robin', years: 8 },
        { name: null, years: 15 },
      ],
      ['Driving lessons this winter', 'Robin swim registration'],
    );
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps);
    expect(result).toMatchObject({ teenScoped: 1, queued: 1 });
    const text = await queuedText(familyId);
    expect(text).toContain('Robin swim registration');
    expect(text).not.toMatch(/driving/i);
  });

  it("an unnamed 15-year-old's thread stays scoped when its next step names the 8-year-old", async () => {
    const familyId = await household(
      [
        { name: 'Robin', years: 8 },
        { name: null, years: 15 },
      ],
      [
        { title: 'Driving lessons this winter', nextStep: 'Then get Robin from school' },
        { title: 'Robin swim registration', nextStep: 'Pick up the gear after' },
      ],
    );
    const result = await runNextDayCheckbackSweep(db.database, NOW, deps);
    expect(result).toMatchObject({ teenScoped: 1, queued: 1 });
    const text = await queuedText(familyId);
    expect(text).toContain('Robin swim registration');
    expect(text).not.toMatch(/driving/i);
  });
});
