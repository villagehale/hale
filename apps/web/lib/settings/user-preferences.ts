import { type Database, schema } from '@hale/db';
import type { UnitSystem } from '@hale/types';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';

/**
 * The signed-in parent's display preferences, read straight off their `users` row:
 * `units` (metric = kg/cm, imperial = lb/in — a DISPLAY choice, never storage) and
 * `weekStartDay` (0=Sunday, 1=Monday). The single source of truth the web card and
 * the mobile preferences route both read, so neither surface re-derives the defaults.
 * Returns the stored row, or the column defaults ({units:'metric', weekStartDay:1})
 * when the user has no row — never a fabricated identity (rule #1).
 */

export interface UserPreferences {
  units: UnitSystem;
  weekStartDay: number;
}

const DEFAULT_PREFERENCES: UserPreferences = { units: 'metric', weekStartDay: 1 };

export async function readUserPreferences(
  userId: string,
  database: Database = defaultDb(),
): Promise<UserPreferences> {
  const [row] = await database
    .select({ units: schema.users.units, weekStartDay: schema.users.weekStartDay })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) return DEFAULT_PREFERENCES;
  return { units: row.units as UnitSystem, weekStartDay: row.weekStartDay };
}
