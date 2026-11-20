import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { type FactHeard, writeFact } from '~/lib/memory/facts';
import { kidFirstName } from './cold-start/ladder';
import type { KidActivity } from './onboarding-turn';

/**
 * VIL-721. What the kids already do, kept as family memory with its provenance.
 *
 * The model read the activities from the parent's own words (the capture's
 * `activities`); code never reads the message to find one. Each kept activity is ONE
 * fact, on the kid it is for when the model named a kid code can find, else on the
 * household:
 *  - `routine`: a kid's regular activity is household logistics, shared with the
 *    other parent under R7 (memory-context.ts SHARED_FACT_TYPES), the same as the
 *    calendar it will end up on.
 *  - provenance on the row itself: `memory_source` parent_message, `source_audience`
 *    and `source_user_id` from who said it and where, `inferred_by` this writer,
 *    `sourced_at` and `valid_from` the turn's clock.
 *  - the kid's name is never in the value. The fact points at the child row; an
 *    activity code cannot place on a kid is the household's and carries no name.
 *
 * One audit row per keep (rule #6), counts only: no activity, no name.
 *
 * Rule #11: every way this ends is named. It never throws into the turn: the reply
 * is the parent's, and a memory write that did not land is logged as exactly that.
 */

export const KID_ACTIVITY_INFERRED_BY = 'onboarding_thread_v2';
/** The model read it from the parent's own words: above the floor, below a record. */
export const KID_ACTIVITY_CONFIDENCE = 0.9;

const KEY_PREFIX = 'kid-activity:';
const MAX_SLUG = 60;

export type KidActivityFactsOutcome =
  | { status: 'kept'; count: number; linked: number }
  | { status: 'nothing_to_keep' }
  /** A write or its audit row did not land; nothing of this keep is stored. */
  | { status: 'failed' };

/**
 * The fact's key: the activity, folded to letters and digits. A phrase with no Latin
 * letters (any other script) keys on a short hash of itself, so every language keys.
 * This names the fact; it decides nothing about what the parent meant.
 */
export function kidActivityFactKey(activity: string): string {
  const folded = activity
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  if (folded.length > 0) return `${KEY_PREFIX}${folded}`;
  const digest = createHash('sha256').update(activity.trim().toLowerCase()).digest('hex');
  return `${KEY_PREFIX}h-${digest.slice(0, 12)}`;
}

interface ChildRow {
  id: string;
  name: string | null;
}

/** The child row an activity names, or the only child when it names none. */
function childFor(item: KidActivity, children: readonly ChildRow[]): string | null {
  if (!item.child) return children.length === 1 ? (children[0]?.id ?? null) : null;
  const wanted = kidFirstName(item.child)?.toLowerCase();
  if (!wanted) return null;
  const match = children.find((row) => kidFirstName(row.name)?.toLowerCase() === wanted);
  return match?.id ?? null;
}

export async function keepKidActivities(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    /** The onboarding session the parent said it in: the audit row's target. */
    sessionId: string;
    activities: readonly KidActivity[];
    /** Where it was said: the parent's own thread, or a thread every adult reads. */
    heardIn: 'one_to_one' | 'family';
    now: Date;
  },
): Promise<KidActivityFactsOutcome> {
  if (input.activities.length === 0) return { status: 'nothing_to_keep' };
  try {
    const rows = await database
      .select({
        id: schema.children.id,
        familyId: schema.children.familyId,
        name: schema.children.name,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, input.familyId))
      .orderBy(asc(schema.children.createdAt));
    // Post-filtered by family, as every reader on this path is.
    const children = rows.filter((row) => row.familyId === input.familyId);
    const heard: FactHeard =
      input.heardIn === 'family'
        ? { in: 'family', userId: input.parentUserId }
        : { in: 'one_to_one', userId: input.parentUserId };
    const placed = input.activities.map((item) => ({ item, childId: childFor(item, children) }));
    await database.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      for (const { item, childId } of placed) {
        await writeFact(tx, {
          familyId: input.familyId,
          childId,
          factType: 'routine',
          factKey: kidActivityFactKey(item.activity),
          factValue: {
            schemaVersion: 1,
            kind: 'kid_activity',
            activity: item.activity,
            when: item.when,
          },
          confidence: KID_ACTIVITY_CONFIDENCE,
          inferredBy: KID_ACTIVITY_INFERRED_BY,
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
        actionTaken: 'onboarding_activities_kept',
        targetTable: 'sms_intake_sessions',
        targetId: input.sessionId,
        after: {
          count: placed.length,
          linked: placed.filter((entry) => entry.childId !== null).length,
        },
      });
    });
    const linked = placed.filter((entry) => entry.childId !== null).length;
    console.info(
      { familyId: input.familyId, count: placed.length, linked },
      'onboarding: kid activities kept',
    );
    return { status: 'kept', count: placed.length, linked };
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'onboarding: kid activities not kept - the reply still goes, the memory did not land',
    );
    return { status: 'failed' };
  }
}
