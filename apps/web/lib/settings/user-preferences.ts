import { type Database, schema } from '@hale/db';
import type { UnitSystem } from '@hale/types';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { resolveUserIdForUser } from '~/lib/family';

/**
 * The signed-in parent's display preferences, read off their `users` row:
 * `units` (metric = kg/cm, imperial = lb/in — a DISPLAY choice, never storage) and
 * `weekStartDay` (0=Sunday, 1=Monday). Keyed by the caller's EXTERNAL auth id (the
 * Auth.js session id / Google sub), which is resolved to the internal users.id here
 * — the session never hands us the uuid — so the mobile routes that read this stay
 * DB-free (rule #1, the lib owns the resolution + the query). Returns the stored row,
 * or the column defaults ({units:'metric', weekStartDay:1}) when the user has no
 * mirrored row yet — never a fabricated identity (rule #1).
 */

export interface UserPreferences {
  units: UnitSystem;
  weekStartDay: number;
}

const DEFAULT_PREFERENCES: UserPreferences = { units: 'metric', weekStartDay: 1 };

export async function readUserPreferences(
  externalAuthId: string,
  database: Database = defaultDb(),
): Promise<UserPreferences> {
  const userId = await resolveUserIdForUser(externalAuthId, database);
  if (!userId) return DEFAULT_PREFERENCES;
  const [row] = await database
    .select({ units: schema.users.units, weekStartDay: schema.users.weekStartDay })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) return DEFAULT_PREFERENCES;
  return { units: row.units as UnitSystem, weekStartDay: row.weekStartDay };
}

/**
 * Writes the parent's display preferences to their `users` row in one transaction
 * with an immutable audit_log row (rule #6), carrying the before/after preference
 * values. The single write path both the web Settings card and the mobile
 * preferences route reach, so a mobile write is audited exactly like a web one.
 * Assumes validated inputs — the callers own the boundary validation.
 */
export async function writeUserPreferences(
  userId: string,
  familyId: string,
  prefs: { units: UnitSystem; weekStartDay: number },
  database: Database = defaultDb(),
): Promise<void> {
  await database.transaction(async (tx) => {
    const existing = await tx
      .select({ units: schema.users.units, weekStartDay: schema.users.weekStartDay })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    await tx
      .update(schema.users)
      .set({ units: prefs.units, weekStartDay: prefs.weekStartDay })
      .where(eq(schema.users.id, userId));

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: 'user_preferences_updated',
      targetTable: 'users',
      targetId: userId,
      before: existing[0] ?? null,
      after: { units: prefs.units, weekStartDay: prefs.weekStartDay },
    });
  });
}
