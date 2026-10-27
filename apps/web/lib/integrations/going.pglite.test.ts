import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SOCIAL_PROOF_MIN } from '~/lib/village/social-proof';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  FREEMAIL_HOSTS,
  GOING_COUNT_ENABLED_ENV,
  type GoingCount,
  goingClause,
  goingCount,
  goingCountEnabled,
  readSessionGoing,
  sessionKey,
} from './going';

/**
 * WHO ELSE IS GOING — the key, the floor and the count.
 *
 * pglite rather than a fake reader, because everything that can be wrong here is SQL:
 * `count(DISTINCT family_id)` against `count(*)` over two co-parent receipts, the FILTER
 * that takes the recipient out BEFORE the floor is applied, the `bool_or` that stops a
 * second receipt speaking a second time, and the `cancelled_at IS NULL` predicate. A fake
 * reader answers all four from whatever it was handed (the recorded "injected fakes hide
 * callee bugs" shape), and the seed-blinding test below is the proof that this one does
 * not.
 */

const FIRST_SESSION = new Date('2026-09-26T13:00:00.000Z');
const HOST = 'recreation.brookfield.example.ca';

let db: TestDb;
let recipient: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.database.delete(schema.activityBookings);
  recipient = await seedFamily(db.database);
});

/** One booking row for one family on one key. The channel message is a real row because
 * `channel_message_id` is a cascading FK and the production DDL is what these tests run
 * against. */
async function book(
  family: { familyId: string; parentUserId: string },
  key: string | null,
  over: { cancelledAt?: Date } = {},
): Promise<string> {
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'email_alert',
      status: 'sent',
    })
    .returning({ id: schema.channelMessages.id });
  const [row] = await db.database
    .insert(schema.activityBookings)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      providerHost: HOST,
      title: 'Swim Level 2',
      firstSessionAt: FIRST_SESSION,
      sessionKey: key,
      channelMessageId: message?.id as string,
      cancelledAt: over.cancelledAt ?? null,
    })
    .returning({ id: schema.activityBookings.id });
  return row?.id as string;
}

/** The key the recipient's own receipt would carry. Derived, never typed out, so a change
 * to the fold moves the fixture with it. */
const KEY = sessionKey({
  providerHost: HOST,
  title: 'Swim Level 2',
  titleIsFallback: false,
  firstSessionAt: FIRST_SESSION,
}) as string;

/** N other families, each holding this session once. */
async function others(count: number, key: string = KEY): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await book(await seedFamily(db.database, `Other ${i}`), key);
  }
}

describe('sessionKey — the one fold, and its four refusals', () => {
  it('is the same string for two samples that differ only in case and whitespace', () => {
    // The MISS is this feature's invisible failure: two families' receipts for one class
    // are two Sonnet samples, and case and spacing are the cheapest way they differ.
    const a = sessionKey({
      providerHost: HOST,
      title: 'Swim Level 2',
      titleIsFallback: false,
      firstSessionAt: FIRST_SESSION,
    });
    const b = sessionKey({
      providerHost: HOST.toUpperCase(),
      title: '  swim   LEVEL  2 ',
      titleIsFallback: false,
      firstSessionAt: new Date(FIRST_SESSION),
    });
    expect(a).not.toBeNull();
    expect(b).toBe(a);
  });

  it('is a DIFFERENT string for a different title, host or instant — the collision bound', () => {
    // The inverse of the test above, and the direction that matters: a collision is a
    // number Hale speaks about strangers it cannot back.
    const base = {
      providerHost: HOST,
      title: 'Swim Level 2',
      titleIsFallback: false,
      firstSessionAt: FIRST_SESSION,
    };
    expect(sessionKey({ ...base, title: 'Swim Level 2 (Sat)' })).not.toBe(sessionKey(base));
    expect(sessionKey({ ...base, providerHost: 'recreation.oakville.example.ca' })).not.toBe(
      sessionKey(base),
    );
    expect(
      sessionKey({ ...base, firstSessionAt: new Date(FIRST_SESSION.getTime() + 60_000) }),
    ).not.toBe(sessionKey(base));
  });

  it('refuses a FALLBACK title — Hale\'s own words are not a session', () => {
    // Every nameless receipt from one host at one instant would otherwise key into one
    // "session" called "a spot", and the count would over-state about strangers.
    expect(
      sessionKey({
        providerHost: HOST,
        title: 'a spot',
        titleIsFallback: true,
        firstSessionAt: FIRST_SESSION,
      }),
    ).toBeNull();
    // The inverse: the same words as a VENDOR's title are a real key.
    expect(
      sessionKey({
        providerHost: HOST,
        title: 'a spot',
        titleIsFallback: false,
        firstSessionAt: FIRST_SESSION,
      }),
    ).not.toBeNull();
  });

  it('refuses a FREEMAIL host — a coach on gmail is a collision engine', () => {
    for (const host of ['gmail.com', 'GMail.com ', 'yahoo.ca', 'icloud.com']) {
      expect(
        sessionKey({
          providerHost: host,
          title: 'Piano',
          titleIsFallback: false,
          firstSessionAt: FIRST_SESSION,
        }),
      ).toBeNull();
    }
    // The inverse, and the reason this is a denylist and not an allowlist: a provider Hale
    // has never parsed a course page for still counts.
    expect(
      sessionKey({
        providerHost: 'piano.studio.example.ca',
        title: 'Piano',
        titleIsFallback: false,
        firstSessionAt: FIRST_SESSION,
      }),
    ).not.toBeNull();
    expect(FREEMAIL_HOSTS.has('gmail.com')).toBe(true);
    expect(FREEMAIL_HOSTS.has('recreation.brookfield.example.ca')).toBe(false);
  });

  it('refuses a title or a host that folds to nothing', () => {
    expect(
      sessionKey({
        providerHost: HOST,
        title: '   ',
        titleIsFallback: false,
        firstSessionAt: FIRST_SESSION,
      }),
    ).toBeNull();
    expect(
      sessionKey({
        providerHost: '',
        title: 'Swim Level 2',
        titleIsFallback: false,
        firstSessionAt: FIRST_SESSION,
      }),
    ).toBeNull();
  });
});

describe('goingCount — the floor, read off the exported constant', () => {
  const read = (others: number): GoingCount => goingCount({ others, alreadyHeld: false });

  it('says nothing below the floor and speaks at it — all four steps', () => {
    // THE FLOOR IS READ, NEVER TYPED. A hard-coded 2 here is a test that cannot notice the
    // constant moving, and the constant is shared with the village card on purpose.
    expect(SOCIAL_PROOF_MIN).toBeGreaterThan(1);
    expect(read(SOCIAL_PROOF_MIN - 2)).toEqual({ shown: false, reason: 'below_floor' });
    expect(read(SOCIAL_PROOF_MIN - 1)).toEqual({ shown: false, reason: 'below_floor' });
    expect(read(SOCIAL_PROOF_MIN)).toEqual({ shown: true, others: SOCIAL_PROOF_MIN });
    expect(read(SOCIAL_PROOF_MIN + 1)).toEqual({ shown: true, others: SOCIAL_PROOF_MIN + 1 });
  });

  it('refuses a family that already holds this session, however many others are in it', () => {
    // The differencing guard: one household reading 2 at 09:00 and 3 at 14:00 has learned
    // that exactly one family registered in between.
    expect(goingCount({ others: SOCIAL_PROOF_MIN + 5, alreadyHeld: true })).toEqual({
      shown: false,
      reason: 'repeat_receipt',
    });
  });
});

describe('goingClause — the sentence, and the population it names', () => {
  it('names HALE families, never families — a count that does not name its population lies', () => {
    const clause = goingClause({ shown: true, others: 2 });
    expect(clause).toBe(', with two other Hale families');
    expect(clause).toContain('other Hale families');
    // The bare phrase would be a claim about the class roster Hale cannot back.
    expect(clause).not.toMatch(/(?<!Hale )other families/);
  });

  it('spells two through nine and switches to numerals at ten', () => {
    expect(goingClause({ shown: true, others: 3 })).toBe(', with three other Hale families');
    expect(goingClause({ shown: true, others: 9 })).toBe(', with nine other Hale families');
    expect(goingClause({ shown: true, others: 10 })).toBe(', with 10 other Hale families');
  });

  it('is empty for every refusal', () => {
    for (const reason of ['below_floor', 'no_session', 'repeat_receipt', 'going_dark'] as const) {
      expect(goingClause({ shown: false, reason })).toBe('');
    }
  });
});

describe('goingCountEnabled — strict, and it fails closed on the trailing newline', () => {
  it("is on for 'true' and off for 'true\\n', unset and 'TRUE'", () => {
    const original = process.env[GOING_COUNT_ENABLED_ENV];
    try {
      process.env[GOING_COUNT_ENABLED_ENV] = 'true';
      expect(goingCountEnabled()).toBe(true);
      // `vercel env add` from a piped echo stores this, and a truthiness check would read
      // it as ON and start speaking about households nobody armed.
      process.env[GOING_COUNT_ENABLED_ENV] = 'true\n';
      expect(goingCountEnabled()).toBe(false);
      process.env[GOING_COUNT_ENABLED_ENV] = 'TRUE';
      expect(goingCountEnabled()).toBe(false);
      delete process.env[GOING_COUNT_ENABLED_ENV];
      expect(goingCountEnabled()).toBe(false);
    } finally {
      if (original === undefined) delete process.env[GOING_COUNT_ENABLED_ENV];
      else process.env[GOING_COUNT_ENABLED_ENV] = original;
    }
  });
});

describe('readSessionGoing — the real query against real rows', () => {
  it('excludes the recipient BEFORE the floor is applied', async () => {
    // Three families booked: the third is told "two other". Two families booked: each sees
    // one other and nothing is said. The positive control is the first assertion.
    await others(2);
    await expect(readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }))
      .resolves.toEqual({ others: 2, alreadyHeld: false });

    const [first] = await db.database
      .select({ familyId: schema.activityBookings.familyId })
      .from(schema.activityBookings);
    // ...and from one of THOSE families' point of view, the same table reads as one other.
    await expect(
      readSessionGoing(db.database, {
        familyId: first?.familyId as string,
        sessionKey: KEY,
      }),
    ).resolves.toEqual({ others: 1, alreadyHeld: true });
  });

  it('counts DISTINCT families, so two co-parent receipts are one household', async () => {
    // The row is per RECEIPT — (integration_id, message_id) — so two co-parents on a
    // provider's list, or one family registering two children, write two rows. Counting
    // rows would make one household read as "two other Hale families".
    const coParented = await seedFamily(db.database, 'Two receipts');
    await book(coParented, KEY);
    await book(coParented, KEY);
    await others(1);
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 2, alreadyHeld: false });
    // Two families, therefore below the floor — the number the count(*) bug would inflate.
    expect(goingCount({ others: 2, alreadyHeld: false })).toEqual({ shown: true, others: 2 });
  });

  it('reports that THIS family already holds the session', async () => {
    await others(3);
    await book(recipient, KEY);
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 3, alreadyHeld: true });
  });

  it('never counts a cancelled booking, in either direction', async () => {
    await others(2);
    const [live] = await db.database
      .select({ id: schema.activityBookings.id })
      .from(schema.activityBookings);
    await db.database
      .update(schema.activityBookings)
      .set({ cancelledAt: new Date('2026-09-20T12:00:00.000Z') })
      .where(eq(schema.activityBookings.id, live?.id as string));
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 1, alreadyHeld: false });
  });

  it('never counts a NULL-keyed booking, and never counts another session', async () => {
    await others(2);
    await book(await seedFamily(db.database, 'No key'), null);
    await book(await seedFamily(db.database, 'Other session'), `${KEY}-different`);
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 2, alreadyHeld: false });
  });

  it('BLINDS THE SEED: with the other families removed the same call answers zero', async () => {
    // The positive control and its mutation in one test. Without this the assertions above
    // would pass against a reader that returns a constant, which is exactly the shape a
    // fake would have.
    await others(2);
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 2, alreadyHeld: false });
    await db.database.delete(schema.activityBookings);
    await expect(
      readSessionGoing(db.database, { familyId: recipient.familyId, sessionKey: KEY }),
    ).resolves.toEqual({ others: 0, alreadyHeld: false });
  });

  it('runs on the PARTIAL index this migration added, not on a sequential scan', async () => {
    // The count reads ACROSS families, so the (family_id, first_session_at) due index
    // cannot serve it. Asserting the index EXISTS with its predicate rather than asserting
    // a plan: pglite's planner on an empty table would choose a scan either way.
    const indexes = (await db.exec(
      "select indexdef from pg_indexes where indexname = 'activity_bookings_session_idx'",
    )) as unknown as Array<{ rows: Array<{ indexdef: string }> }>;
    const def = (Array.isArray(indexes) ? indexes[0]?.rows?.[0]?.indexdef : undefined) ?? '';
    expect(def).toContain('session_key');
    expect(def).toContain('cancelled_at IS NULL');
  });
});
