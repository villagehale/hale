import { schema } from '@hale/db';
import type { UserOverrideOutput } from '@hale/tools-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '../testing/pglite.js';
import { invokeReviewerTool } from './registry.js';

/**
 * VIL-648 · after 0218, one live fact per key per scope. The reviewer's
 * `check_user_override` used to read `.limit(1)` with no ORDER BY, so one
 * adult's `never` and the household's `autonomous_allowed` could fail open.
 * Every live row is read; the most restrictive known value wins, and a
 * value outside that set is treated as never.
 */

const ACTION = 'email_reply';
const KEY = `action_override:${ACTION}`;

describe('check_user_override — the most restrictive live row wins', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    db = await createTestDb();
    ({ familyId, parentUserId } = await seedFamily(db.database));
  }, 120_000);

  afterEach(async () => {
    await db.close();
  });

  async function seedCoParent(): Promise<string> {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `co-${familyId}@example.test`, name: 'Other Parent' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('seedCoParent: users insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: user.id, role: 'co_parent' });
    return user.id;
  }

  async function liveOverride(
    value: unknown,
    heard: { in: 'one_to_one'; userId: string } | { in: 'family'; userId: string | null } = {
      in: 'family',
      userId: null,
    },
  ): Promise<void> {
    await db.database.insert(schema.familyMemoryFacts).values({
      familyId,
      factType: 'preference',
      factKey: KEY,
      factValue: value,
      confidence: 1,
      sourceAudience: heard.in,
      sourceUserId: heard.userId,
    });
  }

  async function check(): Promise<{ ok: boolean; override: UserOverrideOutput['override'] }> {
    const result = await invokeReviewerTool(
      'check_user_override',
      { familyId, actionType: ACTION },
      db.database,
    );
    const parsed = result.result as UserOverrideOutput;
    return { ok: result.ok, override: parsed.override };
  }

  it('"never" plus "autonomous_allowed" is never when never is inserted first', async () => {
    await liveOverride('never', { in: 'one_to_one', userId: parentUserId });
    await liveOverride('autonomous_allowed');

    await expect(check()).resolves.toEqual({ ok: false, override: 'never' });
  });

  it('"never" plus "autonomous_allowed" is never when autonomous_allowed is inserted first', async () => {
    await liveOverride('autonomous_allowed');
    await liveOverride('never', { in: 'one_to_one', userId: parentUserId });

    await expect(check()).resolves.toEqual({ ok: false, override: 'never' });
  });

  it('"always_ask" plus "autonomous_allowed" is always_ask', async () => {
    const coParent = await seedCoParent();
    await liveOverride('autonomous_allowed', { in: 'one_to_one', userId: parentUserId });
    await liveOverride('always_ask', { in: 'one_to_one', userId: coParent });

    await expect(check()).resolves.toEqual({ ok: true, override: 'always_ask' });
  });

  it('a garbage value is the most restrictive answer', async () => {
    await liveOverride('yes', { in: 'one_to_one', userId: parentUserId });
    await liveOverride('autonomous_allowed');

    await expect(check()).resolves.toEqual({ ok: false, override: 'never' });
  });

  it('a single "autonomous_allowed" row still passes', async () => {
    await liveOverride('autonomous_allowed');

    await expect(check()).resolves.toEqual({ ok: true, override: 'autonomous_allowed' });
  });
});
