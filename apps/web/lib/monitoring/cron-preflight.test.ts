import Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-255 · the property the 2026-08-01 incident is about, asserted on EVERY LLM cron:
 * when the provider is out of credit, the window stops at the pre-flight and no family
 * is touched — instead of N identical per-family failures nobody sees for hours.
 *
 * These drive the REAL probe and the REAL classifier through a fake Anthropic client
 * that throws exactly what the SDK throws, so what is under test is our failure
 * handling against the real error shape rather than a stub of our own verdict.
 *
 * The loop cron statically imports query modules that transitively pull next-auth;
 * those edges are stubbed the way lib/loop/cron.test.ts already does so this Node test
 * resolves.
 */
vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/dashboard/trail-query', () => ({
  readFamilyTimezone: vi.fn(async () => 'America/Toronto'),
}));
vi.mock('~/lib/loop/queries', () => ({
  hasWeekPlan: vi.fn(async () => false),
  upsertWeekPlan: vi.fn(async () => ({ id: 'plan-1' })),
}));

import { runNudgeCron } from '~/lib/channel/nudge/run';
import { runInferenceCron } from '~/lib/cron/inference';
import { runWeekPlanCron } from '~/lib/loop/cron';

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const NOW = new Date('2026-08-01T12:00:00Z');
/** Sunday 08:15 America/Toronto — inside the default weekly compose slot (the
 * day before the Monday-morning brief, 2026-08-11 retime). */
const COMPOSE_SLOT = new Date('2026-08-02T12:15:00Z');
/** 10:00 America/Toronto — the nudge send hour. */
const NUDGE_SLOT = new Date('2026-08-01T14:00:00Z');

const CREDIT_EXHAUSTED = Anthropic.APIError.generate(
  400,
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    },
  },
  undefined,
  { 'request-id': 'req_out_of_credit' },
);

/** A client whose every call fails the way the 2026-08-01 outage did. */
function brokeClient(): { client: AgentClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => {
    throw CREDIT_EXHAUSTED;
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

interface DbCapture {
  /** Every table written to. A cron that aborted correctly writes ONLY the incident
   * claim — no agent_runs, no digests, no plans, no audit rows. */
  insertedTables: unknown[];
}

const FAMILY_ROW = {
  id: FAMILY_ID,
  familyId: FAMILY_ID,
  userId: USER_ID,
  parentUserId: USER_ID,
  areaCoarse: 'M4C',
  timezone: 'America/Toronto',
  timeZone: 'America/Toronto',
  weekStartDay: 1,
  provisionedAt: new Date('2026-07-01T00:00:00Z'),
  createdAt: new Date('2026-07-01T00:00:00Z'),
};

interface SelectChain extends Promise<unknown[]> {
  innerJoin: () => SelectChain;
  leftJoin: () => SelectChain;
  where: () => SelectChain;
  groupBy: () => SelectChain;
  having: () => SelectChain;
  orderBy: () => SelectChain;
  limit: () => SelectChain;
}

/** A query builder that is awaitable at ANY link, because the four crons end their
 * selection chain at four different methods. A real Promise carrying the chain methods
 * does that without a hand-rolled thenable. */
function selectChain(rows: unknown[]): SelectChain {
  const chain = Promise.resolve(rows) as SelectChain;
  return Object.assign(chain, {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    having: () => chain,
    orderBy: () => chain,
    limit: () => chain,
  });
}

/**
 * A fake DB that answers each cron's family-selection query and the incident claim, and
 * records every insert so "did any per-family work happen?" is checkable. loop_prefs
 * reads return nothing so the documented defaults apply (weekly plan on, 19:30).
 */
function fakeDb(): { database: Database; capture: DbCapture } {
  const capture: DbCapture = { insertedTables: [] };
  const database = {
    select: () => ({
      from: (table: unknown) =>
        selectChain(table === schema.loopPrefs ? [] : [FAMILY_ROW]),
    }),
    delete: () => ({ where: async () => undefined }),
    insert: (table: unknown) => {
      capture.insertedTables.push(table);
      // Awaitable at any link for the same reason as the select chain: a bare
      // `insert().values()` is awaited directly, an upsert is not.
      return {
        values: () =>
          Object.assign(Promise.resolve(undefined), {
            onConflictDoNothing: () => ({ returning: async () => [{ id: 'incident-row' }] }),
            onConflictDoUpdate: async () => undefined,
            returning: async () => [{ id: 'row-1' }],
          }),
      };
    },
  } as unknown as Database;
  return { database, capture };
}

beforeEach(() => {
  // No founder address and no Resend key: the alert degrades to a clean no-op, so these
  // assert the ABORT, never a real send.
  vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
  vi.stubEnv('WELCOME_BCC', '');
  vi.stubEnv('RESEND_API_KEY', '');
  vi.stubEnv('F14_ENABLED', 'true');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Only the incident claim may be written by an aborted window. */
function assertNoFamilyWork(capture: DbCapture): void {
  expect(capture.insertedTables.filter((table) => table !== schema.rateLimits)).toEqual([]);
}

describe('the memory-inference window (the 06:00Z cron that failed on 2026-08-01)', () => {
  it('aborts before inferring for a single family', async () => {
    const { database, capture } = fakeDb();
    const { client, create } = brokeClient();

    const result = await runInferenceCron(database, { client }, NOW);

    expect(result.aborted?.failure).toBe('billing');
    expect(result.aborted?.skipped).toBe(1);
    expect(result.processed).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    assertNoFamilyWork(capture);
  });
});

describe('the weekly-plan compose window', () => {
  it('aborts before gathering or composing any family', async () => {
    const { database, capture } = fakeDb();
    const { client } = brokeClient();
    const gather = vi.fn();

    const result = await runWeekPlanCron(
      database,
      { client, gather: gather as never, mint: async () => ({ minted: [], skipped: 0 }) },
      COMPOSE_SLOT,
    );

    expect(result.aborted?.failure).toBe('billing');
    expect(result.aborted?.skipped).toBe(1);
    expect(gather).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
    assertNoFamilyWork(capture);
  });

  it('composes as before when the voice stage is off — no client, no probe, no abort', async () => {
    const { database } = fakeDb();
    const gather = vi.fn(async () => {
      throw new Error('gather ran');
    });

    const result = await runWeekPlanCron(
      database,
      { client: null, gather: gather as never, mint: async () => ({ minted: [], skipped: 0 }) },
      COMPOSE_SLOT,
    );

    expect(result.aborted).toBeUndefined();
    expect(gather).toHaveBeenCalledTimes(1);
  });
});

describe('the nudge sweep', () => {
  it('aborts before deciding or composing a nudge for any family', async () => {
    const { database, capture } = fakeDb();
    const { client } = brokeClient();
    const loadChildren = vi.fn(async () => []);

    const result = await runNudgeCron(
      database,
      {
        selectFamilies: async () => [
          {
            familyId: FAMILY_ID,
            parentUserId: USER_ID,
            areaCoarse: 'M4C',
            timeZone: 'America/Toronto',
            provisionedAt: new Date('2026-07-01T00:00:00Z'),
          },
        ],
        loadChildren,
        client,
      } as never,
      NUDGE_SLOT,
    );

    expect(result.aborted?.failure).toBe('billing');
    expect(result.aborted?.skipped).toBe(1);
    expect(result.evaluated).toBe(0);
    expect(loadChildren).not.toHaveBeenCalled();
    assertNoFamilyWork(capture);
  });
});
