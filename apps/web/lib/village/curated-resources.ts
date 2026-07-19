import { type Database, schema } from '@hale/db';
import { asc, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { CURATED_RESOURCES, type CuratedResourceSeed } from './curated-resources-data.js';

/**
 * Curated resources — a hand-verified, family-AGNOSTIC directory read for the
 * Village "Resources" rail. These rows are not tied to a family and carry no PII
 * (rule #1): a resource is a public program's name, category, coarse service area,
 * and outbound URL. The read is a plain ordered lookup (no family scope); the seed
 * is an idempotent upsert so a re-run never duplicates a row.
 */

export interface CuratedResourceView {
  id: string;
  name: string;
  category: string;
  area: string;
  url: string;
  description: string;
}

function toView(row: typeof schema.curatedResources.$inferSelect): CuratedResourceView {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    area: row.area,
    url: row.url,
    description: row.description,
  };
}

/**
 * Read the curated resources in rail order (sortOrder, then name). No family scope
 * and no teen redaction — these are public reference data, not discovered content.
 * An optional `category` narrows the read server-side (e.g. the childcare category),
 * so a caller that wants one kind never over-fetches the whole directory.
 */
export async function readCuratedResources(
  database: Database,
  category?: string,
): Promise<CuratedResourceView[]> {
  const base = database.select().from(schema.curatedResources);
  const scoped = category
    ? base.where(eq(schema.curatedResources.category, category))
    : base;
  const rows = await scoped.orderBy(
    asc(schema.curatedResources.sortOrder),
    asc(schema.curatedResources.name),
  );
  return rows.map(toView);
}

/**
 * The preview/unauthed boundary wrapper (mirrors loadVillage): no DATABASE_URL
 * (credential-less preview) → an empty list; a genuine query failure once a DB
 * exists surfaces (rule #8). Resources are family-agnostic, so unlike loadVillage
 * there is no family resolution — the rail is the same for everyone.
 */
export async function loadCuratedResources(
  category?: string,
): Promise<CuratedResourceView[]> {
  if (!process.env.DATABASE_URL) return [];
  return readCuratedResources(defaultDb(), category);
}

/**
 * Idempotently upsert the verified seed list. Keyed on the (name, area) unique
 * index, so a re-run updates a changed row in place and never duplicates. Returns
 * the number of rows written. Pure over the injected seed so a test can assert
 * idempotency with a fake db.
 */
export async function seedCuratedResources(
  database: Database,
  entries: readonly CuratedResourceSeed[] = CURATED_RESOURCES,
): Promise<{ count: number }> {
  if (entries.length === 0) return { count: 0 };
  await database
    .insert(schema.curatedResources)
    .values(
      entries.map((entry, index) => ({
        name: entry.name,
        category: entry.category,
        area: entry.area,
        url: entry.url,
        description: entry.description,
        sortOrder: index,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.curatedResources.name, schema.curatedResources.area],
      set: {
        category: sqlExcluded('category'),
        url: sqlExcluded('url'),
        description: sqlExcluded('description'),
        sortOrder: sqlExcluded('sort_order'),
      },
    });
  return { count: entries.length };
}

/** Reference the row that would have been inserted, so a conflict updates the
 * existing row to the seed's current values (Drizzle's `sql` excluded reference). */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
