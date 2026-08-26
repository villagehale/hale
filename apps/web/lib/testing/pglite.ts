import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { type Database, schema } from '@hale/db';
import { drizzle } from 'drizzle-orm/pglite';

/**
 * A real Postgres for tests, in-process.
 *
 * The memory layer's correctness lives in SQL — ORDER BY, LIMIT, and a partial
 * unique index — and none of that is observable through the hand-rolled Drizzle
 * chain fakes the rest of this suite uses: a fake returns whatever rows it was
 * handed, so it passes just as happily with no ORDER BY at all. These tests run
 * the REAL production DDL (every committed migration, applied in journal order)
 * against real Postgres, so "the coach sees the top 30 facts by confidence" is
 * proven by the database rather than restated by a stub.
 *
 * Applying the migrations rather than a hand-written fixture schema is what keeps
 * it honest: the table under test is byte-for-byte the one production has, and a
 * new migration is exercised here the first time it ships.
 *
 * The full chain is applied ONCE per worker, then cloned via dumpDataDir. Replaying
 * every SQL file in every beforeEach is what blew Vitest's 10s hookTimeout in CI
 * (deep-answer-at-question-time, twice in a row, while the rest of @hale/web passed).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));

/** Drizzle's per-file statement separator in the generated .sql migrations. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export interface TestDb {
  /** The Drizzle handle, shaped like the production `Database` the code takes. */
  database: Database;
  /** Raw SQL escape hatch — for asserting on indexes and other DDL. */
  exec(sql: string): Promise<unknown>;
  /** Applies ONE migration by filename — how a data-repairing migration is tested
   * against the mess it exists to clean up. */
  applyMigration(file: string): Promise<void>;
  close(): Promise<void>;
}

/** Every committed migration tag, in the order Postgres must apply them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function applyMigrations(client: PGlite, through?: string): Promise<void> {
  for (const file of migrationFiles()) {
    if (through && file > through) break;
    const contents = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
    for (const statement of contents.split(STATEMENT_BREAKPOINT)) {
      if (!statement.trim()) continue;
      await client.exec(statement);
    }
  }
}

/**
 * One migrated WASM snapshot per worker. Cloning it is cheap; replaying every
 * SQL file on every test is not. `through` (partial schema) never shares this.
 */
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

function wrap(client: PGlite): TestDb {
  const applyMigration = async (file: string) => {
    const contents = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
    for (const statement of contents.split(STATEMENT_BREAKPOINT)) {
      if (!statement.trim()) continue;
      await client.exec(statement);
    }
  };

  // `casing` matches createDb so column resolution is identical to production.
  // PgliteDatabase and PostgresJsDatabase differ only in their driver internals;
  // the query surface the code under test uses is the same, and the cast is what
  // lets a test hand this to a function that asks for a real `Database`.
  const database = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;

  return {
    database,
    exec: (sql: string) => client.exec(sql),
    applyMigration,
    close: () => client.close(),
  };
}

/**
 * Boots an empty Postgres and applies migrations up to and including `through`
 * (default: all of them). Stopping early is how a migration proves it repairs
 * pre-existing data — seed the mess against the schema as it was, then apply the
 * migration under test.
 */
export async function createTestDb(through?: string): Promise<TestDb> {
  if (through) {
    const client = await PGlite.create();
    await applyMigrations(client, through);
    return wrap(client);
  }

  const dump = await dumpOfFullSchema();
  const client = await PGlite.create({ loadDataDir: dump });
  return wrap(client);
}

export interface SeededFamily {
  familyId: string;
  parentUserId: string;
}

/**
 * A family with one primary parent — the minimum any memory read needs.
 *
 * `id` is worth pinning when the row's uuid reaches something content-addressed: an
 * eval that caches real model responses keys on the assembled context, and a random
 * family id makes every run a cache miss.
 */
export async function seedFamily(
  database: Database,
  displayName = 'Test Family',
  id?: string,
): Promise<SeededFamily> {
  const [family] = await database
    .insert(schema.families)
    .values({ ...(id ? { id } : {}), displayName, provinceOrState: 'ON' })
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

  return { familyId: family.id, parentUserId: user.id };
}

/** A child row, dated by age so `deriveStage` lands where the test wants it. */
export async function seedChild(
  database: Database,
  familyId: string,
  name: string,
  ageMonths: number,
  id?: string,
): Promise<string> {
  const dob = new Date();
  dob.setMonth(dob.getMonth() - ageMonths);
  const [child] = await database
    .insert(schema.children)
    .values({ ...(id ? { id } : {}), familyId, name, dateOfBirth: dob.toISOString().slice(0, 10) })
    .returning({ id: schema.children.id });
  if (!child) throw new Error('seedChild: children insert returned no row');
  return child.id;
}
