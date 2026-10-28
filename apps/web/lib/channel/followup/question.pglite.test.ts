import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultOpenQuestionReader } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { DAYCARE_FOLLOWUP_QUESTION_TTL_MS, daycareFollowupQuestion } from './question';
import { DAYCARE_FOLLOWUP_TEMPLATE_KEY, daycareFollowupDedupeKey } from './run';

/**
 * The daycare check-in's openness, derived from the ledger, against real Postgres — and
 * the last case through `defaultOpenQuestionReader()`, which is what the router builds.
 *
 * This reader is the whole of the theft fix: `sendFollowup` records a message and
 * threads it and registers nothing, so before it existed a bare "yes" after "how is
 * daycare going?" fell to whatever else was standing.
 */

const TZ = 'America/Toronto';
const ASKED_AT = new Date('2026-09-14T14:04:00.000Z');
const SAME_DAY = new Date('2026-09-14T18:00:00.000Z');
const CHILD_KEY = daycareFollowupDedupeKey('child-mia');

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

interface Seeded {
  familyId: string;
  parentUserId: string;
}

async function seedFamily(): Promise<Seeded> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:daycare', name: 'Ana', timezone: TZ })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

async function seedAsk(
  seeded: Seeded,
  overrides: { createdAt?: Date; status?: 'queued' | 'failed' } = {},
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'followup',
    templateKey: DAYCARE_FOLLOWUP_TEMPLATE_KEY,
    dedupeKey: CHILD_KEY,
    status: overrides.status ?? 'queued',
    createdAt: overrides.createdAt ?? ASKED_AT,
  });
}

describe('daycareFollowupQuestion', () => {
  it('is open while the ask is the newest thing Hale said to that parent', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    expect(await daycareFollowupQuestion(db.database, { ...seeded, now: SAME_DAY })).toMatchObject(
      { askedAt: ASKED_AT },
    );
  });

  it('closes the moment anything else goes out', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);
    await db.database.insert(schema.channelMessages).values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reminder',
      templateKey: 'reminder:day_before',
      status: 'queued',
      createdAt: new Date(ASKED_AT.getTime() + 3_600_000),
    });

    expect(await daycareFollowupQuestion(db.database, { ...seeded, now: SAME_DAY })).toBeNull();
  });

  it('closes past its window, and stands inside it', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const inside = new Date(ASKED_AT.getTime() + DAYCARE_FOLLOWUP_QUESTION_TTL_MS - 60_000);
    const outside = new Date(ASKED_AT.getTime() + DAYCARE_FOLLOWUP_QUESTION_TTL_MS + 60_000);

    expect(await daycareFollowupQuestion(db.database, { ...seeded, now: inside })).not.toBeNull();
    expect(await daycareFollowupQuestion(db.database, { ...seeded, now: outside })).toBeNull();
  });

  it('is closed for a send that never reached the phone', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded, { status: 'failed' });

    expect(await daycareFollowupQuestion(db.database, { ...seeded, now: SAME_DAY })).toBeNull();
  });

  it('reaches the router through the reader the router actually builds', async () => {
    const seeded = await seedFamily();
    await seedAsk(seeded);

    const questions = await defaultOpenQuestionReader().open(db.database, {
      ...seeded,
      now: SAME_DAY,
    });

    const listed = questions.find((question) => question.kind === 'daycare_followup');
    expect(listed).toBeDefined();
    expect(listed?.answerable).toEqual({ yes: false, no: false });
    // Rule #1: neither the provider nor the child in the line that goes to a model.
    expect(listed?.description).not.toContain('Little Sprouts');
    expect(listed?.subject).not.toContain('Little Sprouts');
  });
});
