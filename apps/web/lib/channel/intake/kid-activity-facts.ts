import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { deriveStage, namesAny } from '@hale/types';
import { asc, eq } from 'drizzle-orm';
import { type FactHeard, writeFact } from '~/lib/memory/facts';
import { ONBOARDING_ACTIVITY_WRITER } from '~/lib/memory/lexicon';
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
 *  - the value is the activity and its "when" as the model read them; code adds no
 *    name to it. The fact points at the child row the model named, else the only kid,
 *    else the household. Code does not read the parent's words to decide whose it is.
 *  - a 13+ child's name never rides a row that is not that child's (rule #1, stripped
 *    at the source): the one name check here is that privacy gate, never a placement.
 *    An activity whose words name a teen but which is not on that teen is not kept
 *    (`skipped`). A teen's own row is withheld from every parent-facing read by
 *    memory-context.ts (`notTeen`).
 *  - the key carries no colon: every memory reader drops colon keys as namespaced
 *    (memory-context.ts factsForContext), and these facts are meant to be read.
 *
 * One audit row per keep (rule #6), counts only: no activity, no name.
 *
 * Rule #11: every way this ends is named. It never throws into the turn: the reply
 * is the parent's, and a memory write that did not land is logged as exactly that.
 */

export const KID_ACTIVITY_INFERRED_BY = ONBOARDING_ACTIVITY_WRITER;
/** The model read it from the parent's own words: above the floor, below a record. */
export const KID_ACTIVITY_CONFIDENCE = 0.9;

const KEY_PREFIX = 'kid-activity-';
const MAX_SLUG = 60;
const KEY_HASH_CHARS = 12;

export type KidActivityFactsOutcome =
  /** `skipped`: activities not kept because their words name a teen they are not on. */
  | { status: 'kept'; count: number; linked: number; skipped: number }
  /** Nothing to write: an empty list, or every activity skipped (`skipped` says so). */
  | { status: 'nothing_to_keep'; skipped: number }
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
    .replace(/^-+|-+$/g, '');
  const digest = createHash('sha256')
    .update(activity.trim().toLowerCase())
    .digest('hex')
    .slice(0, KEY_HASH_CHARS);
  if (folded.length === 0) return `${KEY_PREFIX}h-${digest}`;
  if (folded.length <= MAX_SLUG) return `${KEY_PREFIX}${folded}`;
  // Two long phrases that differ past the cut are two activities, not one superseding the other.
  const stem = folded.slice(0, MAX_SLUG - KEY_HASH_CHARS - 1).replace(/-+$/g, '');
  return `${KEY_PREFIX}${stem}-${digest}`;
}

interface ChildRow {
  id: string;
  name: string | null;
  dateOfBirth: string;
}

/** The kids whose name the activity's words carry: read only by the teen privacy gate below. */
function namedIn(item: KidActivity, children: readonly ChildRow[]): ChildRow[] {
  const words = [item.activity, item.when ?? ''].join(' ');
  return children.filter((row) => row.name != null && namesAny(words, [row.name]));
}

/** The child row an activity is for: the kid the model named, else the only kid. Null is the
 * household. */
function childFor(item: KidActivity, children: readonly ChildRow[]): string | null {
  if (item.child) {
    const wanted = kidFirstName(item.child)?.toLowerCase();
    const match = wanted
      ? children.find((row) => kidFirstName(row.name)?.toLowerCase() === wanted)
      : undefined;
    return match?.id ?? null;
  }
  return children.length === 1 ? (children[0]?.id ?? null) : null;
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
  if (input.activities.length === 0) return { status: 'nothing_to_keep', skipped: 0 };
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
    // Post-filtered by family, as every reader on this path is.
    const children = rows.filter((row) => row.familyId === input.familyId);
    const heard: FactHeard =
      input.heardIn === 'family'
        ? { in: 'family', userId: input.parentUserId }
        : { in: 'one_to_one', userId: input.parentUserId };
    const placed: { item: KidActivity; childId: string | null }[] = [];
    let skipped = 0;
    for (const item of input.activities) {
      const childId = childFor(item, children);
      const teenElsewhere = namedIn(item, children).some(
        (row) => row.id !== childId && deriveStage(row.dateOfBirth, input.now) === 'teenager',
      );
      if (teenElsewhere) {
        skipped += 1;
        continue;
      }
      placed.push({ item, childId });
    }
    if (placed.length === 0) {
      console.info(
        { familyId: input.familyId, skipped },
        'onboarding: kid activities not kept - each named a teen it could not be placed on',
      );
      return { status: 'nothing_to_keep', skipped };
    }
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
          ...(skipped > 0 ? { skipped } : {}),
        },
      });
    });
    const linked = placed.filter((entry) => entry.childId !== null).length;
    console.info(
      { familyId: input.familyId, count: placed.length, linked, skipped },
      'onboarding: kid activities kept',
    );
    return { status: 'kept', count: placed.length, linked, skipped };
  } catch (err) {
    console.error(
      { familyId: input.familyId, err: err instanceof Error ? err.name : 'unknown' },
      'onboarding: kid activities not kept - the reply still goes, the memory did not land',
    );
    return { status: 'failed' };
  }
}
