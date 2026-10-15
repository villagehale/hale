import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { CLAIM_EPOCH, claimStamp } from './failure-page';
import {
  LINQ_CAPACITY_ROUTE,
  type LinqChatCount,
  checkLinqCapacity,
  countDbChatIds,
  rateLimitLatchStore,
} from './linq-capacity';

const NOW = new Date('2030-03-04T12:00:00Z');

let testDb: TestDb;

beforeEach(async () => {
  testDb = await createTestDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await testDb.close();
});

function count(total: number): LinqChatCount {
  return {
    total,
    direct: total,
    groups: 0,
    byService: { iMessage: total, SMS: 0, RCS: 0, other: 0 },
    pages: 1,
  };
}

/** The production latch store, a fake Linq count, and a recording #ops. */
function tickerOnDb() {
  const posts: string[] = [];
  const tick = (total: number, now = NOW) =>
    checkLinqCapacity(
      testDb.database,
      {
        countApi: async () => ({ status: 'ok', count: count(total) }),
        countDb: countDbChatIds,
        latches: rateLimitLatchStore(testDb.database),
        sendAlert: async (body) => {
          posts.push(body);
          return 'sent';
        },
      },
      now,
    );
  return { posts, tick };
}

async function latchRows() {
  return testDb.database
    .select({ identifier: schema.rateLimits.identifier, count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.route, LINQ_CAPACITY_ROUTE))
    .orderBy(schema.rateLimits.identifier);
}

describe('rateLimitLatchStore', () => {
  it('P1: the unique index lets one claim win', async () => {
    const store = rateLimitLatchStore(testDb.database);
    await expect(store.claim('pct70', NOW)).resolves.toBe(true);
    await expect(store.claim('pct70', NOW)).resolves.toBe(false);
  });

  it('P2: the boundary sequence pages twice and leaves both thresholds paged', async () => {
    const { posts, tick } = tickerOnDb();
    for (const total of [139, 140, 141, 179, 180]) await tick(total);

    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('70%');
    expect(posts[1]).toContain('90%');
    expect(await latchRows()).toEqual([
      { identifier: 'pct70', count: 1 },
      { identifier: 'pct90', count: 1 },
    ]);
  });

  it('P3: a stamp older than the stale window is released and re-posted; a fresh one is not', async () => {
    const { posts, tick } = tickerOnDb();
    await testDb.database.insert(schema.rateLimits).values({
      identifier: 'pct70',
      route: LINQ_CAPACITY_ROUTE,
      windowStart: CLAIM_EPOCH,
      count: claimStamp(new Date(NOW.getTime() - 60_000)),
    });

    await expect(tick(150)).resolves.toEqual({ outcome: 'latched', total: 150 });
    expect(posts).toHaveLength(0);

    await expect(tick(150, new Date(NOW.getTime() + 2 * 60_000))).resolves.toMatchObject({
      outcome: 'alerted',
      threshold: 'pct70',
    });
    expect(posts).toHaveLength(1);
    expect(await latchRows()).toEqual([{ identifier: 'pct70', count: 1 }]);
  });

  it('P5: a re-arm leaves other routes’ rows with the same identifier intact', async () => {
    const stale = claimStamp(new Date(NOW.getTime() - 10 * 60_000));
    await testDb.database.insert(schema.rateLimits).values([
      { identifier: 'pct70', route: 'ops:delivery-health', windowStart: CLAIM_EPOCH, count: 1 },
      { identifier: 'pct70', route: 'ops:turn-failed', windowStart: CLAIM_EPOCH, count: stale },
    ]);
    const { tick } = tickerOnDb();
    await tick(140);
    // Positive control: our own latch row exists before the re-arm.
    expect(await latchRows()).toEqual([{ identifier: 'pct70', count: 1 }]);

    await expect(tick(120)).resolves.toEqual({ outcome: 'below', total: 120, rearmed: ['pct70'] });

    expect(await latchRows()).toEqual([]);
    const others = await testDb.database
      .select({ route: schema.rateLimits.route, count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .orderBy(schema.rateLimits.route);
    expect(others).toEqual([
      { route: 'ops:delivery-health', count: 1 },
      { route: 'ops:turn-failed', count: stale },
    ]);
  });
});

describe('countDbChatIds', () => {
  it('P4: counts each distinct Linq chat id once across tables, without canary or email rows', async () => {
    const { familyId, parentUserId } = await seedFamily(testDb.database, 'Example Household');
    const groupChat = 'chat-group-0001';
    await testDb.database
      .update(schema.families)
      .set({ linqGroupChatId: groupChat })
      .where(eq(schema.families.id, familyId));
    await testDb.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: groupChat, familyId, source: 'new_group', status: 'confirmed' });
    await testDb.database
      .insert(schema.linqMultiFamilyJoins)
      .values({ chatId: 'chat-shared-0002', familyId });
    const message = { familyId, parentUserId, category: 'reply', status: 'sent' } as const;
    await testDb.database.insert(schema.channelMessages).values([
      { ...message, channel: 'imessage', providerChatId: 'chat-direct-0003' },
      { ...message, channel: 'sms', providerChatId: 'chat-direct-0004' },
      { ...message, channel: 'email', providerChatId: null },
      { ...message, channel: 'imessage', direction: 'in', providerChatId: 'canary-x' },
    ]);

    await expect(countDbChatIds(testDb.database)).resolves.toBe(4);
  });

  it('runs on the DB fallback when Linq is unreachable', async () => {
    const { familyId } = await seedFamily(testDb.database, 'Example Household');
    await testDb.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat-group-0005' })
      .where(eq(schema.families.id, familyId));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const outcome = await checkLinqCapacity(
      testDb.database,
      {
        countApi: async () => ({ status: 'unreachable', reason: 'network' }),
        countDb: countDbChatIds,
        latches: rateLimitLatchStore(testDb.database),
        sendAlert: async () => 'sent',
      },
      NOW,
    );

    expect(outcome).toEqual({ outcome: 'linq_unavailable', reason: 'unreachable', db: 1 });
  });
});
