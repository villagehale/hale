import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { clearForNonAnthropic } from './provider-clearance';

/**
 * The family_state witness against the real DDL: a family may reach a non-Anthropic
 * model only if it has never had a Google integrations row, in any status. The revoked
 * case is the one that matters most: disconnect keeps the row (integrations/store.ts),
 * and that is what lets the witness remember a family whose mail Hale once read.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function addIntegration(
  familyId: string,
  provider: 'gmail' | 'gcal' | 'stripe',
  status: 'active' | 'revoked',
): Promise<void> {
  await db.database.insert(schema.integrations).values({
    familyId,
    userId: null,
    provider,
    status,
    oauthTokensEncrypted: null,
  });
}

function stateOf(familyId: string) {
  return { kind: 'family_state' as const, database: db.database, familyId };
}

describe('clearForNonAnthropic · family_state', () => {
  it('clears a family with no integrations at all', async () => {
    const { familyId } = await seedFamily(db.database, 'Witness None');
    const decision = await clearForNonAnthropic(stateOf(familyId), 'witness');
    if (!('cleared' in decision)) throw new Error(`expected cleared, got ${decision.refused}`);
    expect(decision.cleared.basis).toBe('family_without_google');
  });

  it('positive control: a non-Google row does not refuse', async () => {
    const { familyId } = await seedFamily(db.database, 'Witness Stripe');
    await addIntegration(familyId, 'stripe', 'active');
    const decision = await clearForNonAnthropic(stateOf(familyId), 'witness');
    expect('cleared' in decision).toBe(true);
  });

  it('refuses a family with an active Gmail connection', async () => {
    const { familyId } = await seedFamily(db.database, 'Witness Gmail');
    await addIntegration(familyId, 'gmail', 'active');
    expect(await clearForNonAnthropic(stateOf(familyId), 'witness')).toEqual({
      refused: 'family_has_google_connection',
    });
  });

  it('still refuses after the Calendar connection was revoked and its tokens cleared', async () => {
    const { familyId } = await seedFamily(db.database, 'Witness Revoked');
    await addIntegration(familyId, 'gcal', 'revoked');
    expect(await clearForNonAnthropic(stateOf(familyId), 'witness')).toEqual({
      refused: 'family_has_google_connection',
    });
  });

  it('is scoped to the family asked about', async () => {
    const a = await seedFamily(db.database, 'Witness A');
    const b = await seedFamily(db.database, 'Witness B');
    await addIntegration(a.familyId, 'gmail', 'active');
    expect(await clearForNonAnthropic(stateOf(a.familyId), 'witness')).toEqual({
      refused: 'family_has_google_connection',
    });
    expect('cleared' in (await clearForNonAnthropic(stateOf(b.familyId), 'witness'))).toBe(true);
  });

  it('still refuses after the parent who connected Gmail is deleted and the row cascades away', async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    const { familyId } = await seedFamily(db.database, 'Witness Departed');
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ email: `departed-${familyId}@example.test`, name: 'Departed Parent' })
      .returning({ id: schema.users.id });
    if (!coParent) throw new Error('co-parent insert returned no row');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: coParent.id, role: 'co_parent' });
    await saveConnection(db.database, {
      familyId,
      userId: coParent.id,
      provider: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      tokens: { accessToken: 'test-access', refreshToken: 'test-refresh' },
    });

    await db.database.delete(schema.users).where(eq(schema.users.id, coParent.id));

    // The scenario is real: integrations.user_id cascades, so the row itself is gone.
    const left = await db.database
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, familyId));
    expect(left).toEqual([]);
    expect(await clearForNonAnthropic(stateOf(familyId), 'witness')).toEqual({
      refused: 'family_has_google_connection',
    });
    // Positive control: a family that never connected Google is still cleared.
    const other = await seedFamily(db.database, 'Witness Departed Neighbour');
    expect('cleared' in (await clearForNonAnthropic(stateOf(other.familyId), 'witness'))).toBe(
      true,
    );
  });
});
