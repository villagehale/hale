import { schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROACTIVE_CADENCE_ENV } from '~/lib/channel/proactive/flag';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type DutySendPorts, defaultDutySendPorts, deliverDutyGroupLine } from './asks';
import { COPARENT_DUTY_SENDS_ENABLED_ENV } from './flag';

const FLAG = 'LINQ_REFUSED_FOR_CERTAIN_ENABLED';
const EVENING = new Date('2026-09-27T22:00:00.000Z');
const AN_HOUR_LATER = new Date(EVENING.getTime() + 60 * 60_000);
const TIMEOUT = 'timeout';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv(PROACTIVE_CADENCE_ENV, 'off');
  vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Only fetch is stubbed: the first POST fails as scripted, the next is accepted. */
function linqFailingOnce(first: number | typeof TIMEOUT) {
  const keys: string[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    keys.push(JSON.parse(String(init?.body)).message.idempotency_key);
    if (keys.length > 1) {
      return Response.json({ message: { id: 'out-accepted' } }, { status: 201 });
    }
    if (first === TIMEOUT) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return Response.json({ error: { code: first } }, { status: first });
  }) as unknown as typeof fetch;
  return { fetchImpl, keys };
}

function realTransportPorts(): DutySendPorts {
  return {
    ...defaultDutySendPorts(),
    target: async () => ({ channel: 'group', chatId: 'chat-duty', familyId: 'ignored' }),
    gate: async () => ({ allowed: true as const, optOut: 'short' as const }),
    gatePorts: () => ({
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      parentTimeZone: async () => 'America/Toronto',
    }),
    pager: { page: async () => 'paged' as const },
  };
}

async function sendTwice(first: number | typeof TIMEOUT) {
  const family = await seedFamily(db.database, `Refusal ${first}`);
  const { fetchImpl, keys } = linqFailingOnce(first);
  const dedupeKey = `duty_ask:refusal-${family.familyId}`;
  for (const now of [EVENING, AN_HOUR_LATER]) {
    await deliverDutyGroupLine(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        text: 'A model-written duty question.',
        now,
        dedupeKey,
        templateKey: 'linq:group_duty_night_before',
        sendsActive: true,
        composed: true,
        fetch: fetchImpl,
      },
      realTransportPorts(),
    );
  }
  const rows = await db.database
    .select({ status: schema.channelMessages.status })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, family.familyId),
        eq(schema.channelMessages.direction, 'out'),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
  return { keys, statuses: rows.map((row) => row.status) };
}

describe('a duty text Linq may have taken, with the flag on', () => {
  it.each([408, 409, 425, 418, 502, TIMEOUT] as const)(
    'a %s then an accept is two POSTs under one key and one sent row',
    async (first) => {
      vi.stubEnv(FLAG, 'true');
      const { keys, statuses } = await sendTwice(first);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(statuses).toEqual(['failed', 'sent']);
    },
  );

  it.each([400, 422])('a %i proved a refusal, so the next try has its own key', async (first) => {
    vi.stubEnv(FLAG, 'true');
    const { keys, statuses } = await sendTwice(first);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(statuses).toEqual(['failed', 'sent']);
  });
});

describe('with the flag off', () => {
  it('a 409 then an accept takes a new key, as main does', async () => {
    const { keys, statuses } = await sendTwice(409);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(statuses).toEqual(['failed', 'sent']);
  });
});
