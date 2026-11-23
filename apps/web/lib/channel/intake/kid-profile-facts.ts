import { type Database, schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { type FactHeard, writeFact } from '~/lib/memory/facts';
import { kidFirstName } from './cold-start/ladder';
import { deriveDateOfBirth } from './derive';
import type { ExtractedChild } from './extract';
import { KID_ACTIVITY_CONFIDENCE } from './kid-activity-facts';

/**
 * VIL-721. The kids' names and ages as the model read them from the parent's words, kept
 * in family memory with their provenance: who said it, where and when.
 *
 * The `children` row stays the record every prompt reads, so a remembered age can never
 * go stale in a reply (VIL-519). This row is what the parent told Hale, so the key is
 * namespaced: no prompt read and no recall carries it, and the access export does.
 * `logistic` because both parents already see a kid's name and age (R7). A 13+ kid's row
 * sits on that kid and is withheld in the export like any other row about them.
 *
 * One audit row per keep (rule #6), counts only: no name, no age.
 *
 * Rule #11: every way this ends is named. It never throws into the turn.
 */
export const KID_PROFILE_FACT_KEY = 'onboarding_record:kid_profile';
export const KID_PROFILE_INFERRED_BY = 'onboarding_thread_v2_record';

export type KidProfileFactsOutcome =
  /** `skipped`: kids the model read that no child row could be matched to. */
  | { status: 'kept'; count: number; skipped: number }
  | { status: 'nothing_to_keep'; skipped: number }
  /** A write or its audit row did not land; nothing of this keep is stored. */
  | { status: 'failed' };

interface ChildRow {
  id: string;
  name: string | null;
  dateOfBirth: string;
}

/**
 * The row this read is about: by first name. A read with no name: the only child, else
 * the row whose date of birth this age derives to on the same clock. No match is no
 * row, never a guess between siblings.
 */
function rowFor(
  child: ExtractedChild,
  rows: readonly ChildRow[],
  taken: ReadonlySet<string>,
  now: Date,
): ChildRow | undefined {
  const open = rows.filter((row) => !taken.has(row.id));
  const first = kidFirstName(child.name)?.toLowerCase();
  const named = first
    ? open.find((row) => kidFirstName(row.name)?.toLowerCase() === first)
    : undefined;
  if (named) return named;
  // A kid the model named who has no row of their own is not put on a sibling's.
  if (first) return undefined;
  if (rows.length === 1) return open[0];
  const dob =
    child.dateOfBirth ??
    (child.ageMonths != null
      ? deriveDateOfBirth(child.ageMonths, child.agePrecision ?? 'years', now)
      : null);
  return dob ? open.find((row) => row.dateOfBirth === dob) : undefined;
}

export async function keepKidProfiles(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    /** The onboarding session the parent said it in: the audit row's target. */
    sessionId: string;
    children: readonly ExtractedChild[];
    /** Where it was said: the parent's own thread, or a thread every adult reads. */
    heardIn: 'one_to_one' | 'family';
    now: Date;
  },
): Promise<KidProfileFactsOutcome> {
  const read = input.children.filter((child) => child.name?.trim() || child.ageMonths != null);
  if (read.length === 0) return { status: 'nothing_to_keep', skipped: 0 };
  try {
    const rows = await database
      .select({
        id: schema.children.id,
        familyId: schema.children.familyId,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId))
      .orderBy(asc(schema.children.createdAt));
    const family = rows.filter((row) => row.familyId === input.familyId);
    const heard: FactHeard =
      input.heardIn === 'family'
        ? { in: 'family', userId: input.parentUserId }
        : { in: 'one_to_one', userId: input.parentUserId };
    const taken = new Set<string>();
    const placed: { child: ExtractedChild; childId: string }[] = [];
    for (const child of read) {
      const row = rowFor(child, family, taken, input.now);
      if (!row) continue;
      taken.add(row.id);
      placed.push({ child, childId: row.id });
    }
    const skipped = read.length - placed.length;
    if (placed.length === 0) {
      console.info(
        { familyId: input.familyId, skipped },
        'onboarding: kid names and ages not kept - no child row matched',
      );
      return { status: 'nothing_to_keep', skipped };
    }
    await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      for (const { child, childId } of placed) {
        await writeFact(tx, {
          familyId: input.familyId,
          childId,
          factType: 'logistic',
          factKey: KID_PROFILE_FACT_KEY,
          factValue: {
            schemaVersion: 1,
            kind: 'kid_profile',
            name: kidFirstName(child.name) ?? (child.name?.trim() || null),
            ageMonths: child.ageMonths,
            agePrecision: child.agePrecision,
          },
          confidence: KID_ACTIVITY_CONFIDENCE,
          inferredBy: KID_PROFILE_INFERRED_BY,
          heard,
          validFrom: input.now,
          memoryKind: 'lasting',
          memorySource: 'parent_message',
          sourcedAt: input.now,
        });
      }
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.parentUserId,
        // A literal, so the trail's drift guard reads it (trail/verbs-drift.test.ts).
        actionTaken: 'onboarding_kids_kept',
        targetTable: 'sms_intake_sessions',
        targetId: input.sessionId,
        // Said in one parent's own thread, it is that parent's row on the trail.
        audience: input.heardIn === 'one_to_one' ? input.parentUserId : null,
        after: { count: placed.length, ...(skipped > 0 ? { skipped } : {}) },
      });
    });
    console.info(
      { familyId: input.familyId, count: placed.length, skipped },
      'onboarding: kid names and ages kept',
    );
    return { status: 'kept', count: placed.length, skipped };
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'onboarding: kid names and ages not kept - the reply still goes, the memory did not land',
    );
    return { status: 'failed' };
  }
}
