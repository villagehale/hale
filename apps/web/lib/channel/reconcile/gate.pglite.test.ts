import type { Database } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db as appDb } from '~/lib/db';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { ClaimShadow, ClaimShadowStart } from './claim-shadow';
import { refuseUnbackedSend, unsendableReasons } from './gate';

/**
 * VIL-581 · the send-boundary gate's decision is unchanged by the shadow: computed and
 * returned exactly as before, whatever the shadow answers, with the shadow handed the
 * very verdict the decision came from. The regex path runs against the real DDL.
 */

const FAMILY = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-11-03T12:00:00Z');
const UNBACKED = "I'll stop sending the one-sec messages.";
const PLAIN = 'Your swim lesson is on Saturday.';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

type SweepCall = Parameters<ClaimShadow['sweep']>;
function fakeShadow(answer: ClaimShadowStart) {
  const calls: SweepCall[] = [];
  const shadow: ClaimShadow = {
    sweep: (...args) => {
      calls.push(args);
      return answer;
    },
    coachTurn: () => {
      throw new Error('not a coach path');
    },
    dispatch: () => {
      throw new Error('not a dispatch path');
    },
  };
  return { shadow, calls };
}

/** A database that refuses any query: the no-claim path must never ask it anything. */
const NO_QUERIES = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('the no-claim path queried the database');
    },
  },
) as unknown as Database;

describe('refuseUnbackedSend — the decision is unchanged', () => {
  beforeEach(() => {
    vi.stubEnv('CLAIM_READER_MODE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('an unbacked body is refused the same way whatever the shadow answers', async () => {
    for (const answer of ['started', 'busy', 'off'] as const) {
      const { shadow } = fakeShadow(answer);
      const decision = await refuseUnbackedSend(
        t.database,
        { familyId: FAMILY, body: UNBACKED, now: NOW },
        shadow,
      );
      // Positive control: the equality below is not vacuous.
      expect(decision.length).toBeGreaterThan(0);
      expect(decision).toEqual(['self_referential']);
    }
  });

  it('a claim-free body asks the database nothing and hands the shadow a null verdict', async () => {
    const { shadow, calls } = fakeShadow('started');
    expect(
      await refuseUnbackedSend(NO_QUERIES, { familyId: FAMILY, body: PLAIN, now: NOW }, shadow),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(NO_QUERIES);
    expect(calls[0]?.[1]).toMatchObject({ verdict: null, view: null, body: PLAIN });
  });

  it('the shadow gets the caller’s database and the very verdict the decision came from', async () => {
    const { shadow, calls } = fakeShadow('started');
    const decision = await refuseUnbackedSend(
      t.database,
      { familyId: FAMILY, body: UNBACKED, now: NOW },
      shadow,
    );
    const [database, input] = calls[0] as SweepCall;
    expect(database).toBe(t.database);
    expect(input.verdict).not.toBeNull();
    expect(input.view).not.toBeNull();
    expect(unsendableReasons(input.verdict as NonNullable<typeof input.verdict>)).toEqual(decision);
  });
});

describe('refuseUnbackedSend — lane and recipient', () => {
  beforeEach(() => {
    vi.stubEnv('CLAIM_READER_MODE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a named lane and recipient pass through', async () => {
    const { shadow, calls } = fakeShadow('started');
    await refuseUnbackedSend(
      t.database,
      { familyId: FAMILY, body: PLAIN, now: NOW, lane: 'followup_ask', parentUserId: 'parent-p' },
      shadow,
    );
    expect(calls[0]?.[1]).toMatchObject({ lane: 'followup_ask', parentUserId: 'parent-p' });
  });

  it('no lane is the unlabelled sweep, read for the primary parent', async () => {
    const { shadow, calls } = fakeShadow('started');
    await refuseUnbackedSend(t.database, { familyId: FAMILY, body: PLAIN, now: NOW }, shadow);
    expect(calls[0]?.[1]).toMatchObject({ lane: 'sweep_unlabelled', parentUserId: null });
  });
});

describe('refuseUnbackedSend — the production default shadow, with no env', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ['DATABASE_URL', 'CLAIM_READER_MODE']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('decides exactly as before with no third argument', async () => {
    expect(
      await refuseUnbackedSend(t.database, { familyId: FAMILY, body: UNBACKED, now: NOW }),
    ).toEqual(['self_referential']);
    expect(
      await refuseUnbackedSend(t.database, { familyId: FAMILY, body: PLAIN, now: NOW }),
    ).toEqual([]);
  });

  it('the app pool would throw in this env, so the default shadow never reached it (positive control)', () => {
    expect(() => appDb()).toThrow('DATABASE_URL is not set');
  });
});
