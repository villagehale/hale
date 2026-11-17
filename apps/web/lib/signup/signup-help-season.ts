import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import type { SignupHelpSeasonFacts } from './outcome-reply';

/**
 * Serializes Browser Use season-slot claims for one family. Concurrent yeses
 * from two parents cannot both take the last slot: the lock plus
 * `ON CONFLICT … WHERE attempted < cap RETURNING` refuse the extra increment.
 */
function familyLockKey(familyId: string): string {
  return `signup_help:${familyId}`;
}

export async function signupHelpAttempted(
  database: Database,
  input: { familyId: string; seasonKey: string },
): Promise<number> {
  const [row] = await database
    .select({ attempted: schema.familySignupHelpSeasons.attempted })
    .from(schema.familySignupHelpSeasons)
    .where(
      and(
        eq(schema.familySignupHelpSeasons.familyId, input.familyId),
        eq(schema.familySignupHelpSeasons.seasonKey, input.seasonKey),
      ),
    )
    .limit(1);
  return row?.attempted ?? 0;
}

export type ClaimSignupHelpResult =
  | { ok: true; attempted: number }
  | { ok: false; attempted: number };

/**
 * Atomically counts one Browser Use attempt against `cap` for this family and
 * season. Returns `{ ok: false }` without writing when the family is already
 * at the cap. Does not count dry-runs: the caller claims immediately before
 * `runner.run()`.
 */
export async function claimSignupHelpAttempt(
  database: Database,
  input: { familyId: string; seasonKey: string; cap: number; now: Date },
): Promise<ClaimSignupHelpResult> {
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${familyLockKey(input.familyId)}))`);
    const [row] = await tx
      .insert(schema.familySignupHelpSeasons)
      .values({
        familyId: input.familyId,
        seasonKey: input.seasonKey,
        attempted: 1,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [schema.familySignupHelpSeasons.familyId, schema.familySignupHelpSeasons.seasonKey],
        set: {
          attempted: sql`${schema.familySignupHelpSeasons.attempted} + 1`,
          updatedAt: input.now,
        },
        setWhere: sql`${schema.familySignupHelpSeasons.attempted} < ${input.cap}`,
      })
      .returning({ attempted: schema.familySignupHelpSeasons.attempted });
    if (row) return { ok: true, attempted: row.attempted };
    const used = await signupHelpAttempted(tx, input);
    return { ok: false, attempted: used };
  });
}

export function signupHelpSeasonFacts(input: {
  used: number;
  cap: number;
  resetsOn: string;
}): SignupHelpSeasonFacts {
  return { used: input.used, cap: input.cap, resetsOn: input.resetsOn };
}
