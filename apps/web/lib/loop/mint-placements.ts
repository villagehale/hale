import { type AgentClient, SONNET_MODEL } from '@hale/agent';
import { type Database, type WeekPlanItem, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { dedupHashFor, recordVerdict } from '~/lib/pipeline/record';
import { reviewAction } from '~/lib/pipeline/review';

/**
 * Mints held `calendar_add` drafts from a composed week plan (VIL-219 / B3).
 *
 * For every item the composer flagged `needs: 'calendar_add'`, this synthesizes a
 * recompose-stable dedup key, mints a draft HELD at drafted_for_approval through
 * the SAME approval engine the inbound pipeline uses (draftInlineAction mold), and
 * reviews it (rule #3). It never executes (rule #4) — placement onto family_events
 * happens only when a parent approves and the executor's calendar_add runs.
 *
 * Recompose-idempotency: the synthetic event's dedup hash is derived from the item's
 * provenance (its sourceRef, or a stable key from week + title + day for appointment
 * items whose sourceRef is null). Re-composing the same week collides that hash
 * (onConflictDoNothing on (family_id, dedup_hash)), so a second run re-mints nothing.
 * The same hash is stamped as the draft payload's `action_hash`, so the reviewer's
 * check_action_idempotency is a second line of defense (it excludes the row under
 * review by its persisted id).
 */

const PLACEMENT_SOURCE = 'week_plan';
const PLACEMENT_EVENT_TYPE = 'week_plan.calendar_add';

export interface MintPlacementsInput {
  familyId: string;
  /** Monday of the covered week, family-local `YYYY-MM-DD` (the week_plan.weekStart). */
  weekStart: string;
  items: WeekPlanItem[];
  /** The family's IANA timezone — day-coarse item day-keys resolve to the
   * family-local start-of-day instant with it. */
  timeZone: string;
  /** Audit actor (rule #6) — the family's primary parent / the compose job's owner. */
  actor: string;
}

export interface MintPlacementsResult {
  /** Action ids newly minted this run. */
  minted: string[];
  /** Items that need placement but were already minted on a prior compose. */
  skipped: number;
}

export async function mintCalendarDraftsForWeekPlan(
  input: MintPlacementsInput,
  database: Database,
  client: AgentClient,
  now: Date = new Date(),
): Promise<MintPlacementsResult> {
  const minted: string[] = [];
  let skipped = 0;

  for (const item of input.items) {
    if (item.needs !== 'calendar_add' || item.startsAt === null) {
      // Only dated items become placements; a null day can't be a calendar entry.
      continue;
    }

    const dedupHash = dedupHashFor(
      input.familyId,
      PLACEMENT_SOURCE,
      placementDedupKey(input.weekStart, item),
    );
    const childId = item.childIds[0] ?? null;
    const teenContent =
      childId !== null && (await isTeenChild(input.familyId, childId, database, now));

    const insertedEvent = await database
      .insert(schema.events)
      .values({
        familyId: input.familyId,
        source: PLACEMENT_SOURCE,
        eventType: PLACEMENT_EVENT_TYPE,
        childId,
        teenContent,
        payload: { weekStart: input.weekStart, title: item.title, sourceRef: item.sourceRef },
        classifierSuggestion: { kind: 'autonomous_action', actionType: 'calendar_add' },
        classifiedAt: now,
        dedupHash,
        status: 'drafted',
      })
      .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
      .returning({ id: schema.events.id });

    const eventId = insertedEvent[0]?.id;
    if (!eventId) {
      skipped += 1;
      continue;
    }

    const payload = {
      title: item.title,
      startsAt: zonedDayStartInstant(item.startsAt, input.timeZone).toISOString(),
      endsAt: null,
      location: item.location,
      childId,
      sourceRef: item.sourceRef,
      // Carried onto family_events.sensitive by the calendar_add executor, so reminders
      // genericize a health placement's copy for everyone (VIL-223).
      privacySensitive: item.privacySensitive,
      action_hash: dedupHash,
    };

    const insertedAction = await database
      .insert(schema.actions)
      .values({
        eventId,
        familyId: input.familyId,
        actionType: 'calendar_add',
        payload,
        userVisibleState: 'drafted_for_approval',
      })
      .onConflictDoNothing({ target: schema.actions.eventId })
      .returning({ id: schema.actions.id });

    const actionId = insertedAction[0]?.id;
    if (!actionId) {
      skipped += 1;
      continue;
    }

    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.actor,
      actionTaken: 'week_plan.calendar_drafted',
      targetTable: 'actions',
      targetId: actionId,
      after: { actionType: 'calendar_add', dedupHash, sourceRef: item.sourceRef },
    });

    const verdict = await reviewAction(
      {
        familyId: input.familyId,
        draft: {
          id: actionId,
          eventId,
          familyId: input.familyId,
          actionType: 'calendar_add',
          payload,
          draftConfidence: 1,
          rationale: `Weekly plan placement: ${item.title}`,
          recipientVisibility: 'internal_only',
          draftedAt: now.toISOString(),
        },
      },
      database,
      client,
    );

    await recordVerdict(database, {
      familyId: input.familyId,
      eventId,
      actionId,
      actionType: 'calendar_add',
      verdict: verdict.verdict,
      usage: verdict.usage,
      model: SONNET_MODEL,
    });

    minted.push(actionId);
  }

  return { minted, skipped };
}

/**
 * The recompose-stable dedup key for an item. Provenance-first: an item with a
 * sourceRef (a saved village activity, a family_events occasion) keys on that row,
 * so it dedups no matter how the week is re-sliced. An appointment item has no
 * sourceRef, so it keys on the stable (week, title, day) triple — the same checkup
 * on the same week re-composes to the same key. familyId is folded in by the caller
 * (dedupHashFor prepends it), so it is not repeated here.
 */
function placementDedupKey(weekStart: string, item: WeekPlanItem): string {
  if (item.sourceRef) {
    return `${item.sourceRef.table}:${item.sourceRef.id}`;
  }
  return `${weekStart}|${item.title}|${item.startsAt ?? 'undated'}`;
}

/**
 * The UTC instant of family-local start-of-day for a `YYYY-MM-DD` day-key — the
 * inverse of dayKeyIn, and the established all-day storage convention (family_events
 * comment). Offset is measured by formatting one instant in the target zone vs UTC;
 * the machine's own timezone cancels out of the difference.
 */
export function zonedDayStartInstant(dayKey: string, timeZone: string): Date {
  const utcMidnight = new Date(`${dayKey}T00:00:00Z`);
  const inZone = new Date(utcMidnight.toLocaleString('en-US', { timeZone }));
  const inUtc = new Date(utcMidnight.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = inUtc.getTime() - inZone.getTime();
  return new Date(utcMidnight.getTime() + offsetMs);
}

/** Whether a child is a teenager right now (age-derived, never a stored flag).
 * Family-scoped; a foreign or missing child reads as non-teen. */
async function isTeenChild(
  familyId: string,
  childId: string,
  database: Database,
  now: Date,
): Promise<boolean> {
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)));
  const dob = rows[0]?.dateOfBirth;
  return dob !== undefined && deriveStage(dob, now) === 'teenager';
}
