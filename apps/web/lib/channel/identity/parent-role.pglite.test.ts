import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { loadParentRole, storeParentRole } from './parent-role';

/**
 * The 0153 columns and their checks are real here, and so is the deploy
 * window before the migration has run: the columns are dropped and the reads
 * and the write must come back named, not thrown.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seed(label: string): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: label, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ name: null })
    .returning({ id: schema.users.id });
  if (!family || !user) throw new Error('seed returned no row');
  await db.database.insert(schema.familyMembers).values({
    familyId: family.id,
    userId: user.id,
    role: 'primary_parent',
  });
  return { familyId: family.id, userId: user.id };
}

describe('parent role on postgres', () => {
  it('stores a guess, lets a statement replace it, and never the reverse', async () => {
    const { familyId, userId } = await seed('Household');
    expect(
      await storeParentRole(db.database, {
        familyId,
        parentUserId: userId,
        guess: { role: 'mother', basis: 'guessed' },
      }),
    ).toBe('stored');
    expect(await loadParentRole(db.database, userId)).toEqual({ role: 'mother', basis: 'guessed' });
    expect(
      await storeParentRole(db.database, {
        familyId,
        parentUserId: userId,
        guess: { role: 'father', basis: 'stated' },
      }),
    ).toBe('stored');
    expect(
      await storeParentRole(db.database, {
        familyId,
        parentUserId: userId,
        guess: { role: 'mother', basis: 'guessed' },
      }),
    ).toBe('kept_stated');
    expect(await loadParentRole(db.database, userId)).toEqual({ role: 'father', basis: 'stated' });
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken, after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits.map((row) => row.action)).toEqual([
      'parent_role_recorded',
      'parent_role_recorded',
    ]);
  });

  it('refuses a value outside the enum at the table', async () => {
    const { userId } = await seed('Checked');
    await expect(
      db.database.execute(sql`UPDATE users SET parent_role = 'parent' WHERE id = ${userId}`),
    ).rejects.toThrow(/users_parent_role_check/);
  });

  it('names a missing column instead of throwing, before 0153 has run', async () => {
    const { familyId, userId } = await seed('Early');
    await db.database.execute(sql`ALTER TABLE users DROP COLUMN parent_role`);
    await db.database.execute(sql`ALTER TABLE users DROP COLUMN parent_role_basis`);
    try {
      expect(
        await storeParentRole(db.database, {
          familyId,
          parentUserId: userId,
          guess: { role: 'mother', basis: 'guessed' },
        }),
      ).toBe('column_missing');
      expect(await loadParentRole(db.database, userId)).toBeNull();
    } finally {
      await db.database.execute(sql`ALTER TABLE users ADD COLUMN parent_role text`);
      await db.database.execute(sql`ALTER TABLE users ADD COLUMN parent_role_basis text`);
    }
  });
});
