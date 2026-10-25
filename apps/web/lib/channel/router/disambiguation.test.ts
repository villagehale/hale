import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { DISAMBIGUATION_TTL_MS, createDisambiguationStore } from './disambiguation';
import type { OpenQuestion } from './open-questions';

const WELCOME: OpenQuestion = {
  id: 'offer-1',
  kind: 'founder_welcome_offer',
  description: 'An offer to send your welcome note to a new family.',
  subject: 'sending your welcome note to the new family',
  answerable: { yes: true, no: true },
  askedAt: null,
  solicited: false,
};

const CALENDAR: OpenQuestion = {
  id: 'action-1',
  kind: 'approval',
  description: 'Move swim to Tuesday.',
  subject: 'move swim to tuesday',
  answerable: { yes: true, no: true },
  askedAt: null,
  solicited: false,
};

/**
 * The store, against REAL Postgres and the real committed DDL (lib/testing/pglite.ts).
 *
 * The two things worth proving here cannot be proven any other way: the partial unique
 * index is what makes "at most one live menu per parent" a fact rather than a convention,
 * and an upsert that names it has to actually conflict on it — a `targetWhere` that does
 * not line up with the index either 23505s in production or silently inserts a second live
 * row, and both of those look perfectly fine through a query-builder fake.
 */
describe('the menus own memory', () => {
  let db: TestDb;
  const NOW = new Date('2026-08-24T18:00:00.000Z');
  const store = createDisambiguationStore();

  // ONE Postgres for the file, and a fresh HOUSEHOLD per test. Booting a WASM instance per
  // test is what blew the hook timeout on the suite that already does it
  // (lib/testing/pglite.ts's own note), and every row here is scoped to a parent id anyway.
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const option = (q: OpenQuestion) => ({
    questionId: q.id,
    kind: q.kind,
    subject: q.subject,
  });

  async function household() {
    return seedFamily(db.database);
  }

  it('writes a menu down and hands back exactly what was printed', async () => {
    const seeded = await household();

    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR), option(WELCOME)],
      now: NOW,
    });

    expect(await store.pending(db.database, { ...seeded, now: NOW })).toEqual({
      id: expect.any(String),
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR), option(WELCOME)],
    });
  });

  it('supersedes rather than accumulating - one live menu per parent', async () => {
    const seeded = await household();

    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-2',
      polarity: 'no',
      numbered: false,
      options: [option(WELCOME)],
      now: NOW,
    });

    // The SECOND question is the one standing in front of them. Two live lists would be
    // two things one reply could be read against.
    expect(await store.pending(db.database, { ...seeded, now: NOW })).toMatchObject({
      polarity: 'no',
      numbered: false,
      options: [option(WELCOME)],
    });
    const counted = (await db.exec(
      `SELECT count(*)::int AS n FROM pending_disambiguations
       WHERE parent_user_id = '${seeded.parentUserId}'`,
    )) as Array<{ rows: Array<{ n: number }> }>;
    expect(counted[0]?.rows[0]?.n).toBe(1);
  });

  it('is gone once it has been spent', async () => {
    const seeded = await household();
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });
    const live = await store.pending(db.database, { ...seeded, now: NOW });

    await store.consume(db.database, { id: live?.id as string, now: NOW });

    expect(await store.pending(db.database, { ...seeded, now: NOW })).toBeNull();
    // And a spent row does not block the next question from being asked.
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-2',
      polarity: 'yes',
      numbered: true,
      options: [option(WELCOME)],
      now: NOW,
    });
    expect(await store.pending(db.database, { ...seeded, now: NOW })).toMatchObject({
      options: [option(WELCOME)],
    });
  });

  it('can only be spent once, whatever order two turns reach it in', async () => {
    // One-shot is what stops a menu answering a later, unrelated text, and today it rests
    // on the queue handing this parent's inbounds over one at a time. That is a property
    // of the enqueue rather than of this table, so the spend states it itself: the UPDATE
    // only matches a row nobody has spent, and a turn that matched nothing is told so
    // rather than carrying on as though it had won the race (rule #11).
    const seeded = await household();
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });
    const live = await store.pending(db.database, { ...seeded, now: NOW });

    expect(await store.consume(db.database, { id: live?.id as string, now: NOW })).toBe('spent');
    expect(await store.consume(db.database, { id: live?.id as string, now: NOW })).toBe(
      'already_spent',
    );
  });

  it('stops standing once it is stale', async () => {
    const seeded = await household();
    await store.mint(db.database, {
      ...seeded,
      channelMessageId: 'msg-1',
      polarity: 'yes',
      numbered: true,
      options: [option(CALENDAR)],
      now: NOW,
    });

    const later = new Date(NOW.getTime() + DISAMBIGUATION_TTL_MS + 1000);
    expect(await store.pending(db.database, { ...seeded, now: later })).toBeNull();
    // The positive control for the assertion above: one second inside the window, the
    // same row is still there. Without it a broken read would pass this test.
    const inside = new Date(NOW.getTime() + DISAMBIGUATION_TTL_MS - 1000);
    expect(await store.pending(db.database, { ...seeded, now: inside })).not.toBeNull();
  });

  it('refuses a polarity that is not one of the two words', async () => {
    const seeded = await household();

    await expect(
      db.exec(`INSERT INTO pending_disambiguations
        (family_id, parent_user_id, asked_from, polarity, numbered, options)
        VALUES ('${seeded.familyId}', '${seeded.parentUserId}', 'msg-1', 'maybe', true, '[]'::jsonb)`),
    ).rejects.toThrow();
  });
});
