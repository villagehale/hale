import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionFromIntake } from './provision';

/**
 * The transcript REPLAY, which is the only place a pre-provisioning message becomes a
 * ledger row. What it writes there is the only thing every downstream surface — the
 * founder health digest, the funnel scoreboard, a support answer — will ever know about
 * whether Hale's first message actually reached the parent.
 *
 * A pre-provisioning greeting has no ledger row while it is in flight, so its delivery
 * receipt resolves `unknown_message` and cannot be applied. The replay therefore knows
 * exactly one thing about that message: it was handed to the provider. Recording it as
 * 'sent' — carrier accepted it — asserts a fact nothing in the system ever learned, and
 * a carrier silently filtering every first message looks identical to one delivering
 * them.
 */

/**
 * A fake Drizzle handle: one transaction, insert/select chains that record what they
 * were given. Each table gets a stable synthetic id so the real code's
 * "insert returned no row" guards pass and the ids stay distinguishable.
 */
function fakeDatabase() {
  const inserts: Array<{ table: string; values: unknown }> = [];

  function tableName(table: unknown): string {
    const symbols = Object.getOwnPropertySymbols(table as object);
    for (const sym of symbols) {
      if (String(sym).includes('Name')) {
        const value = (table as Record<symbol, unknown>)[sym];
        if (typeof value === 'string') return value;
      }
    }
    return 'unknown';
  }

  function insert(table: unknown) {
    const name = tableName(table);
    const rows = [{ id: `${name}-id` }];
    const builder = {
      values(v: unknown) {
        inserts.push({ table: name, values: v });
        return builder;
      },
      returning: async () => rows,
      onConflictDoNothing: async () => rows,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return builder;
  }

  const handle = {
    insert,
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: async () => [{ id: `${tableName(table)}-id` }] }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(handle),
  };

  return { database: handle as unknown as Database, inserts };
}

function channelMessageRows(inserts: Array<{ table: string; values: unknown }>) {
  return inserts
    .filter((row) => row.table === 'channel_messages')
    .map((row) => row.values as Record<string, unknown>);
}

const NOW = new Date('2026-08-12T14:00:00Z');

function input() {
  return {
    phoneE164: '+14165551234',
    phoneHash: 'blind-index-hash',
    children: [{ name: 'Maya', ageMonths: 30, agePrecision: 'years' as const }],
    location: { postalCode: 'M4C 1B5', areaCoarse: 'M4C' },
    sourceCode: null,
    firstMessage: 'Maya is 2, we are at M4C 1B5',
    transcript: [
      { direction: 'out' as const, body: 'greeting', providerId: 'SM_out_1', at: NOW.toISOString() },
      { direction: 'in' as const, body: 'Maya is 2', providerId: 'SM_in_1', at: NOW.toISOString() },
    ],
    now: NOW,
  };
}

describe('provisionFromIntake — replayed transcript status', () => {
  beforeEach(() => {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('records a replayed outbound as queued — submitted to the provider, delivery never confirmed', async () => {
    const { database, inserts } = fakeDatabase();

    await provisionFromIntake(database, input());

    const outbound = channelMessageRows(inserts).filter((row) => row.direction === 'out');
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.status).toBe('queued');
  });

  /**
   * The consequence, stated as the invariant rather than the value: the funnel
   * scoreboard counts 'sent' and 'delivered' as reaching the parent. A replayed message
   * whose receipt was never applied must not be counted among them.
   */
  it('keeps a replayed outbound out of the statuses that mean the parent received it', async () => {
    const { database, inserts } = fakeDatabase();

    await provisionFromIntake(database, input());

    const outbound = channelMessageRows(inserts).filter((row) => row.direction === 'out');
    expect(['sent', 'delivered']).not.toContain(outbound[0]?.status);
  });

  /** An inbound IS known to have arrived — we are holding it. That claim stays. */
  it('still records a replayed inbound as delivered', async () => {
    const { database, inserts } = fakeDatabase();

    await provisionFromIntake(database, input());

    const inbound = channelMessageRows(inserts).filter((row) => row.direction === 'in');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.status).toBe('delivered');
  });
});
