import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type Database, schema } from '@hale/db';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * A real Postgres for worker tests, in-process — the worker-side twin of
 * apps/web/lib/testing/pglite.ts, and deliberately the same shape: the claims this
 * package's writes now make (the calendar placement's unique index, the human-approval
 * checkpoint's conditional UPDATE, migration 0106) are DECIDED by the database, and a
 * hand-rolled Drizzle chain fake returns whatever it was told — it can never lose a
 * claim (the injected-fakes lesson). Every committed migration is applied in journal
 * order, so the tables under test are byte-for-byte the ones production has.
 *
 * Applied ONCE per worker and cloned via dumpDataDir, for the same hookTimeout reason
 * the web harness records.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export interface TestDb {
  database: Database;
  close(): Promise<void>;
}

async function applyMigrations(client: PGlite): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const contents = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
    for (const statement of contents.split(STATEMENT_BREAKPOINT)) {
      if (!statement.trim()) continue;
      await client.exec(statement);
    }
  }
}

let fullSchemaDump: Promise<Blob> | undefined;

async function dumpOfFullSchema(): Promise<Blob> {
  fullSchemaDump ??= (async () => {
    const client = await PGlite.create();
    await applyMigrations(client);
    const dump = await client.dumpDataDir('none');
    await client.close();
    return dump;
  })();
  return fullSchemaDump;
}

export async function createTestDb(): Promise<TestDb> {
  const dump = await dumpOfFullSchema();
  const client = await PGlite.create({ loadDataDir: dump });
  // `casing` matches createDb so column resolution is identical to production.
  const database = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
  return { database, close: () => client.close() };
}

export interface SeededFamily {
  familyId: string;
  parentUserId: string;
}

/** A family with one primary parent — the minimum the executor's writes need. */
export async function seedFamily(database: Database, displayName = 'Test Family') {
  const [family] = await database
    .insert(schema.families)
    .values({ displayName, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  if (!family) throw new Error('seedFamily: families insert returned no row');

  const [user] = await database
    .insert(schema.users)
    .values({ email: `${family.id}@example.test`, name: 'Test Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seedFamily: users insert returned no row');

  await database
    .insert(schema.familyMembers)
    .values({ familyId: family.id, userId: user.id, role: 'primary_parent' });

  return { familyId: family.id, parentUserId: user.id } satisfies SeededFamily;
}
