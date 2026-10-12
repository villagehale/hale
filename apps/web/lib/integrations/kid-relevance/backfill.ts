import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { SuppressReason } from '~/lib/loop/reminders/schedule';
import {
  type KidJudgement,
  type StoredKidJudgement,
  judgeKidRelevance,
  loadKidRelevanceChildren,
  loadNotMineHints,
  readStoredKidVerdicts,
  seriesKeyForEvent,
} from './judge';
import type { KidRelevanceItem } from './skill-contract';
import { CLEARED_EVENT_TEXT, dropOwedTexts } from './untrack';

/**
 * The one-off kid-relevance backfill (VIL-226 item 5).
 *
 * Judges what Hale already holds from connectors - mirrored Google events, family events
 * a parent added from a Gmail offer, parent calendar blocks flagged as kid-related, and
 * live activity bookings - and, with `apply`:
 *   - soft-deletes every adult family event, clearing its title and place, and cancels
 *     its scheduled reminders with `kid_relevance_backfill`, one audit row each (rule #6);
 *   - clears `kid_related` and the title on an adult parent block;
 *   - links each judged event to its verdict (and its child when the event had none), so
 *     the reminder gate can read it.
 * Adult activity bookings are only counted (founder default D10). `unsure` and held items
 * are counted and left alone: not dropped and not linked, so the live gate judges them
 * again on its own terms.
 *
 * A dry run changes no tracking state and writes no audit row. It does store the verdicts
 * themselves (the judge's cache). An apply asks no model: it acts only on a verdict already
 * stored for the item's input as it is now, and counts every other item as `notInDryRun`,
 * untouched, so it never drops on a verdict no dry run counted. Both return counts only
 * (rule #1).
 *
 * Skipped, and counted (rule #11): a copy whose connection is gone or no longer active, and
 * every family with an erasure scheduled - their titles are not sent to the model again.
 * The erasure check is read again inside each family's write, so a family that schedules
 * one while a run is in flight gets no tracking state written. The verdict rows are not
 * under that lock: a dry run upserts them as it judges, before any write, so that family
 * can still gain verdict rows. They go with the family (the `family_id` cascade).
 */

export interface BackfillInput {
  apply: boolean;
  now: Date;
  /** Where a dry run stops asking the model; an apply asks none. */
  deadline: Date;
  /** Restrict to these families; every family with connector rows when omitted. */
  familyIds?: readonly string[];
  /** Stamped on every audit row an apply writes, so `revertKidRelevanceBackfill` can find
   * exactly what this run did. */
  runId: string;
}

export interface BackfillCounts {
  apply: boolean;
  families: number;
  judged: number;
  kid: number;
  adult: number;
  unsure: number;
  held: number;
  eventsDropped: number;
  remindersCancelled: number;
  blocksCleared: number;
  adultBookings: number;
  /** Apply only: items with no stored verdict for their input as it is now - added or
   * changed since the dry run. Not sent to the model, not touched; the next dry run
   * judges them. */
  notInDryRun: number;
  /** Copies whose connection is gone or not active: not judged, not touched. */
  skippedDisconnected: number;
  /** Families with an erasure scheduled: nothing of theirs is sent to the model again, or,
   * when it was scheduled while the run was judging, written. */
  skippedFamiliesPendingErasure: number;
}

const BACKFILL_REASON: SuppressReason = 'kid_relevance_backfill';

/**
 * Whether the calendar mirror leaves a verdict-dropped copy dropped. It does not yet: a
 * soft-deleted mirror row whose event is still on the parent's Google Calendar reads as a
 * change, so the next connector sync writes it back live with its title and place. Flipped
 * in the same change that teaches the mirror to read the verdict.
 */
export const CALENDAR_MIRROR_HONOURS_KID_VERDICTS = false;

export type BackfillApplyDecision =
  | { outcome: 'allowed' }
  | { outcome: 'mirror_not_wired'; reason: string };

/** Whether the script may run in this mode. Only an apply is ever refused. */
export function backfillApplyDecision(
  mode: { apply: boolean; revert: boolean },
  mirrorHonoursVerdicts: boolean,
): BackfillApplyDecision {
  if (!mode.apply || mode.revert || mirrorHonoursVerdicts) return { outcome: 'allowed' };
  return {
    outcome: 'mirror_not_wired',
    reason:
      'the calendar mirror does not read kid verdicts yet, so its next sync would put back every calendar copy an apply drops',
  };
}

type Target =
  | { kind: 'event'; id: string }
  | { kind: 'block'; integrationId: string; eventId: string }
  | { kind: 'booking'; id: string };

interface Candidate {
  item: KidRelevanceItem;
  target: Target;
}

export async function runKidRelevanceBackfill(
  database: Database,
  input: BackfillInput,
  ports: { client: AgentClient },
): Promise<BackfillCounts> {
  const counts: BackfillCounts = {
    apply: input.apply,
    families: 0,
    judged: 0,
    kid: 0,
    adult: 0,
    unsure: 0,
    held: 0,
    eventsDropped: 0,
    remindersCancelled: 0,
    blocksCleared: 0,
    adultBookings: 0,
    notInDryRun: 0,
    skippedDisconnected: 0,
    skippedFamiliesPendingErasure: 0,
  };

  const { byFamily, skippedDisconnected, skippedFamiliesPendingErasure } = await loadCandidates(
    database,
    input.familyIds,
  );
  counts.skippedDisconnected = skippedDisconnected;
  counts.skippedFamiliesPendingErasure = skippedFamiliesPendingErasure;
  for (const [familyId, candidates] of byFamily) {
    counts.families += 1;
    const asked = { familyId, items: candidates.map((c) => c.item), now: input.now };
    const context = {
      children: await loadKidRelevanceChildren(database, familyId),
      notMineHints: await loadNotMineHints(database, familyId),
    };
    const judged: readonly (KidJudgement | StoredKidJudgement)[] = input.apply
      ? await readStoredKidVerdicts(database, asked, context)
      : await judgeKidRelevance(
          database,
          { ...asked, deadline: input.deadline },
          { client: ports.client, ...context },
        );
    const verdictByRef = new Map(judged.map((judgement) => [judgement.ref, judgement]));

    const adultEvents: { id: string; item: KidRelevanceItem }[] = [];
    const adultBlocks: { integrationId: string; eventId: string; item: KidRelevanceItem }[] = [];
    const links: { eventId: string; judgement: Extract<KidJudgement, { verdictId: string }> }[] =
      [];
    for (const candidate of candidates) {
      const judgement = verdictByRef.get(candidate.item.ref);
      if (!judgement) throw new Error('kid-relevance backfill: an item came back unjudged');
      if (judgement.verdict === 'held' && judgement.why === 'not_stored') {
        counts.notInDryRun += 1;
        continue;
      }
      counts.judged += 1;
      if (judgement.verdict === 'held') {
        counts.held += 1;
        continue;
      }
      counts[judgement.verdict] += 1;
      if (judgement.verdict === 'unsure') continue;
      if (candidate.target.kind === 'event') {
        links.push({ eventId: candidate.target.id, judgement });
        if (judgement.verdict === 'adult') {
          adultEvents.push({ id: candidate.target.id, item: candidate.item });
        }
      } else if (candidate.target.kind === 'block') {
        if (judgement.verdict === 'adult') {
          adultBlocks.push({ ...candidate.target, item: candidate.item });
        }
      } else if (judgement.verdict === 'adult') {
        counts.adultBookings += 1;
      }
    }

    const scheduled =
      adultEvents.length === 0
        ? []
        : await database
            .select({ id: schema.eventReminders.id, eventRef: schema.eventReminders.eventRef })
            .from(schema.eventReminders)
            .where(
              and(
                inArray(
                  schema.eventReminders.eventRef,
                  adultEvents.map((event) => event.id),
                ),
                eq(schema.eventReminders.status, 'scheduled'),
              ),
            );
    const tally = () => {
      counts.eventsDropped += adultEvents.length;
      counts.remindersCancelled += scheduled.length;
      counts.blocksCleared += adultBlocks.length;
    };
    if (!input.apply) {
      tally();
      continue;
    }

    const applied = await database.transaction(async (tx) => {
      if ((await lockFamiliesUnderErasure(tx, [familyId])).size > 0) return false;
      for (const link of links) {
        await tx
          .update(schema.familyEvents)
          .set({ kidVerdictId: link.judgement.verdictId })
          .where(
            and(eq(schema.familyEvents.id, link.eventId), isNull(schema.familyEvents.kidVerdictId)),
          );
        if (link.judgement.childId !== null) {
          await tx
            .update(schema.familyEvents)
            .set({ childId: link.judgement.childId })
            .where(
              and(eq(schema.familyEvents.id, link.eventId), isNull(schema.familyEvents.childId)),
            );
        }
      }
      if (adultEvents.length > 0) {
        await tx
          .update(schema.familyEvents)
          .set({ deletedAt: input.now, ...CLEARED_EVENT_TEXT })
          .where(
            inArray(
              schema.familyEvents.id,
              adultEvents.map((event) => event.id),
            ),
          );
        const owed: Awaited<ReturnType<typeof dropOwedTexts>>[] = [];
        for (const event of adultEvents) owed.push(await dropOwedTexts(tx, event.item, input.now));
        await tx.insert(schema.auditLog).values(
          adultEvents.map((event, index) => ({
            familyId,
            actor: 'system',
            actionTaken: 'kid_relevance_event_dropped',
            targetTable: 'family_events',
            targetId: event.id,
            after: {
              verdict: 'adult',
              source: event.item.source,
              reason: BACKFILL_REASON,
              runId: input.runId,
              ...owed[index],
            },
            occurredAt: input.now,
          })),
        );
      }
      if (scheduled.length > 0) {
        await tx
          .update(schema.eventReminders)
          .set({ status: 'cancelled', suppressReason: BACKFILL_REASON, updatedAt: input.now })
          .where(
            inArray(
              schema.eventReminders.id,
              scheduled.map((row) => row.id),
            ),
          );
        await tx.insert(schema.auditLog).values(
          scheduled.map((row) => ({
            familyId,
            actor: 'system',
            actionTaken: 'kid_relevance_reminder_cancelled',
            targetTable: 'event_reminders',
            targetId: row.id,
            after: { reason: BACKFILL_REASON, runId: input.runId },
            occurredAt: input.now,
          })),
        );
      }
      for (const block of adultBlocks) {
        await tx
          .update(schema.parentCalendarBlocks)
          .set({ kidRelated: false, title: null, updatedAt: input.now })
          .where(
            and(
              eq(schema.parentCalendarBlocks.integrationId, block.integrationId),
              eq(schema.parentCalendarBlocks.eventId, block.eventId),
            ),
          );
        const owed = await dropOwedTexts(tx, block.item, input.now);
        await tx.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'kid_relevance_event_dropped',
          targetTable: 'parent_calendar_blocks',
          targetId: `${block.integrationId}:${block.eventId}`,
          after: {
            verdict: 'adult',
            source: block.item.source,
            reason: BACKFILL_REASON,
            runId: input.runId,
            ...owed,
          },
          occurredAt: input.now,
        });
      }
      return true;
    });
    if (applied) tally();
    else counts.skippedFamiliesPendingErasure += 1;
  }
  return counts;
}

export interface RevertCounts {
  runId: string;
  /** False when no audit row carries this run id; nothing was changed. */
  found: boolean;
  eventsRestored: number;
  remindersRescheduled: number;
  verdictsCleared: number;
  /** Dropped events the parent has since said are theirs (a parent's adult verdict): left
   * dropped, their reminders left cancelled. */
  skippedParentOwned: number;
  /** Families with an erasure scheduled: nothing of theirs is restored. */
  skippedFamiliesPendingErasure: number;
}

/**
 * Undo one apply, found by its run id in the audit rows it wrote.
 *
 * Each family event that run dropped comes back live and unlinked, unless it has been
 * dropped again since (its `deleted_at` no longer matches the run's), its family has an
 * erasure scheduled, or the parent has since said it is theirs (its verdict is now a
 * parent's `adult`; untrack does not re-stamp a copy that is already dropped) - each read
 * inside the restore's own transaction, the last two counted by name. Its reminders that
 * run cancelled and that are still ahead are scheduled again. The model verdicts for the
 * restored items are deleted so the next judge asks again; a parent's own verdict stays.
 * One audit row per restored event (rule #6), carrying how many of its family's events
 * were left dropped as the parent's own.
 *
 * A Gmail copy gets its title and place back from the offer it came from, which the apply
 * leaves as it was. Not restored: a calendar copy's title and place (the mirror's next pass
 * rewrites them), and parent calendar blocks (the next sweep rebuilds them). Returns
 * counts only.
 */
export async function revertKidRelevanceBackfill(
  database: Database,
  input: { runId: string; now: Date },
): Promise<RevertCounts> {
  const counts: RevertCounts = {
    runId: input.runId,
    found: false,
    eventsRestored: 0,
    remindersRescheduled: 0,
    verdictsCleared: 0,
    skippedParentOwned: 0,
    skippedFamiliesPendingErasure: 0,
  };
  const audit = schema.auditLog;
  const ofRun = await database
    .select({
      familyId: audit.familyId,
      action: audit.actionTaken,
      targetTable: audit.targetTable,
      targetId: audit.targetId,
      occurredAt: audit.occurredAt,
    })
    .from(audit)
    .where(
      and(
        inArray(audit.actionTaken, [
          'kid_relevance_event_dropped',
          'kid_relevance_reminder_cancelled',
        ]),
        sql`${audit.after}->>'runId' = ${input.runId}`,
      ),
    );
  if (ofRun.length === 0) return counts;
  counts.found = true;

  const droppedAt = new Map<string, number>();
  const cancelledIds: string[] = [];
  for (const row of ofRun) {
    if (row.targetId === null) continue;
    if (row.action === 'kid_relevance_reminder_cancelled') cancelledIds.push(row.targetId);
    else if (row.targetTable === 'family_events') {
      droppedAt.set(row.targetId, row.occurredAt.getTime());
    }
  }
  if (droppedAt.size === 0) return counts;

  await database.transaction(async (tx) => {
    const dropped = await tx
      .select({
        id: schema.familyEvents.id,
        familyId: schema.familyEvents.familyId,
        deletedAt: schema.familyEvents.deletedAt,
        kidVerdictId: schema.familyEvents.kidVerdictId,
      })
      .from(schema.familyEvents)
      .where(inArray(schema.familyEvents.id, [...droppedAt.keys()]));
    const ofThisRun = dropped.filter(
      (row) => row.deletedAt !== null && row.deletedAt.getTime() === droppedAt.get(row.id),
    );
    const erasing = await lockFamiliesUnderErasure(tx, [
      ...new Set(ofThisRun.map((row) => row.familyId)),
    ]);
    counts.skippedFamiliesPendingErasure = erasing.size;
    const restorable = ofThisRun.filter((row) => !erasing.has(row.familyId));
    const parentOwned = await lockParentAdultVerdicts(
      tx,
      restorable.flatMap((row) => (row.kidVerdictId === null ? [] : [row.kidVerdictId])),
    );
    const isParentOwned = (row: (typeof restorable)[number]) =>
      row.kidVerdictId !== null && parentOwned.has(row.kidVerdictId);
    const skipped = restorable.filter(isParentOwned);
    counts.skippedParentOwned = skipped.length;
    const restore = restorable.filter((row) => !isParentOwned(row));
    if (restore.length === 0) return;
    const restoreIds = restore.map((row) => row.id);

    await tx
      .update(schema.familyEvents)
      .set({ deletedAt: null, kidVerdictId: null })
      .where(inArray(schema.familyEvents.id, restoreIds));
    await tx
      .update(schema.familyEvents)
      .set({
        title: sql`${schema.emailAlertOffers.title}`,
        location: sql`${schema.emailAlertOffers.location}`,
      })
      .from(schema.emailAlertOffers)
      .where(
        and(
          eq(schema.emailAlertOffers.eventId, schema.familyEvents.id),
          inArray(schema.familyEvents.id, restoreIds),
        ),
      );
    const rescheduled =
      cancelledIds.length === 0
        ? []
        : await tx
            .update(schema.eventReminders)
            .set({ status: 'scheduled', suppressReason: null, updatedAt: input.now })
            .where(
              and(
                inArray(schema.eventReminders.id, cancelledIds),
                inArray(schema.eventReminders.eventRef, restoreIds),
                eq(schema.eventReminders.status, 'cancelled'),
                eq(schema.eventReminders.suppressReason, BACKFILL_REASON),
                gt(schema.eventReminders.fireAt, input.now),
              ),
            )
            .returning({ eventRef: schema.eventReminders.eventRef });
    const verdictIds = [
      ...new Set(restore.flatMap((row) => (row.kidVerdictId === null ? [] : [row.kidVerdictId]))),
    ];
    const cleared =
      verdictIds.length === 0
        ? []
        : await tx
            .delete(schema.kidRelevanceVerdicts)
            .where(
              and(
                inArray(schema.kidRelevanceVerdicts.id, verdictIds),
                eq(schema.kidRelevanceVerdicts.decidedBy, 'model'),
              ),
            )
            .returning({ id: schema.kidRelevanceVerdicts.id });
    await tx.insert(schema.auditLog).values(
      restore.map((row) => ({
        familyId: row.familyId,
        actor: 'system',
        actionTaken: 'kid_relevance_event_restored',
        targetTable: 'family_events',
        targetId: row.id,
        after: {
          runId: input.runId,
          remindersRescheduled: rescheduled.filter((r) => r.eventRef === row.id).length,
          skippedParentOwned: skipped.filter((s) => s.familyId === row.familyId).length,
        },
        occurredAt: input.now,
      })),
    );
    counts.eventsRestored = restore.length;
    counts.remindersRescheduled = rescheduled.length;
    counts.verdictsCleared = cleared.length;
  });
  return counts;
}

/** The one erasure predicate: a family with a deletion scheduled. */
const erasureScheduled = () => isNotNull(schema.families.scheduledDeletionAt);

/**
 * Which of these families have an erasure scheduled, read inside the transaction that
 * writes for them. FOR SHARE holds their rows until it commits, so an erasure cannot be
 * scheduled between this read and those writes.
 */
async function lockFamiliesUnderErasure(
  tx: Pick<Database, 'select'>,
  familyIds: readonly string[],
): Promise<Set<string>> {
  if (familyIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: schema.families.id, erasing: sql<boolean>`${erasureScheduled()}` })
    .from(schema.families)
    .where(inArray(schema.families.id, [...familyIds]))
    .for('share');
  return new Set(rows.filter((row) => row.erasing).map((row) => row.id));
}

/**
 * Which of these verdicts are a parent's own `adult`, read inside the transaction that
 * restores. FOR SHARE holds the rows until it commits, so a parent's untrack cannot land
 * between this read and the restore.
 */
async function lockParentAdultVerdicts(
  tx: Pick<Database, 'select'>,
  verdictIds: readonly string[],
): Promise<Set<string>> {
  if (verdictIds.length === 0) return new Set();
  const table = schema.kidRelevanceVerdicts;
  const rows = await tx
    .select({ id: table.id, decidedBy: table.decidedBy, verdict: table.verdict })
    .from(table)
    .where(inArray(table.id, [...new Set(verdictIds)]))
    .for('share');
  return new Set(
    rows
      .filter((row) => row.decidedBy === 'parent' && row.verdict === 'adult')
      .map((row) => row.id),
  );
}

async function loadCandidates(
  database: Database,
  familyIds: readonly string[] | undefined,
): Promise<{
  byFamily: Map<string, Candidate[]>;
  skippedDisconnected: number;
  skippedFamiliesPendingErasure: number;
}> {
  const byFamily = new Map<string, Candidate[]>();
  let skippedDisconnected = 0;
  const pendingErasureSkipped = new Set<string>();
  if (familyIds?.length === 0) {
    return { byFamily, skippedDisconnected, skippedFamiliesPendingErasure: 0 };
  }
  // Every read below is scoped in SQL, so a run for one family never loads another's rows.
  const scoped = (column: AnyPgColumn) => (familyIds ? inArray(column, [...familyIds]) : undefined);

  // An offer or a booking names its connection without a foreign key, so it can outlive
  // a disconnect; a verdict cannot, because its integration_id cascades. A connection the
  // parent revoked, or one that expired or errored, is not live either: the same
  // `active` status the connector reads gate on.
  const connected = new Set(
    (
      await database
        .select({ id: schema.integrations.id })
        .from(schema.integrations)
        .where(and(eq(schema.integrations.status, 'active'), scoped(schema.integrations.familyId)))
    ).map((row) => row.id),
  );
  const pendingErasure = new Set(
    (
      await database
        .select({ id: schema.families.id })
        .from(schema.families)
        .where(and(erasureScheduled(), scoped(schema.families.id)))
    ).map((row) => row.id),
  );
  const add = (familyId: string, candidate: Candidate) => {
    if (pendingErasure.has(familyId)) {
      pendingErasureSkipped.add(familyId);
      return;
    }
    if (candidate.item.integrationId !== null && !connected.has(candidate.item.integrationId)) {
      skippedDisconnected += 1;
      return;
    }
    const list = byFamily.get(familyId) ?? [];
    list.push(candidate);
    byFamily.set(familyId, list);
  };

  const mirrors = await database
    .select({
      id: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      location: schema.familyEvents.location,
      googleEventId: schema.familyEvents.googleEventId,
      integrationId: schema.familyEvents.integrationId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        isNotNull(schema.familyEvents.googleEventId),
        isNotNull(schema.familyEvents.integrationId),
        isNull(schema.familyEvents.deletedAt),
        scoped(schema.familyEvents.familyId),
      ),
    );
  for (const row of mirrors) {
    if (row.googleEventId === null || row.integrationId === null) continue;
    add(row.familyId, {
      target: { kind: 'event', id: row.id },
      item: {
        ref: `event:${row.id}`,
        source: 'google_calendar',
        integrationId: row.integrationId,
        itemKey: await seriesKeyForEvent(database, row.integrationId, row.googleEventId),
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        place: row.location,
        sender: null,
      },
    });
  }

  const offers = await database
    .select({
      id: schema.familyEvents.id,
      familyId: schema.familyEvents.familyId,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      location: schema.familyEvents.location,
      integrationId: schema.emailAlertOffers.integrationId,
      messageId: schema.emailAlertOffers.messageId,
    })
    .from(schema.emailAlertOffers)
    .innerJoin(schema.familyEvents, eq(schema.familyEvents.id, schema.emailAlertOffers.eventId))
    .where(
      and(
        eq(schema.emailAlertOffers.resolution, 'added'),
        isNull(schema.familyEvents.deletedAt),
        scoped(schema.familyEvents.familyId),
      ),
    );
  for (const row of offers) {
    add(row.familyId, {
      target: { kind: 'event', id: row.id },
      item: {
        ref: `event:${row.id}`,
        source: 'gmail',
        integrationId: row.integrationId,
        itemKey: row.messageId,
        title: row.title,
        startsAt: row.startsAt.toISOString(),
        place: row.location,
        sender: null,
      },
    });
  }

  const blocks = await database
    .select()
    .from(schema.parentCalendarBlocks)
    .where(
      and(
        eq(schema.parentCalendarBlocks.kidRelated, true),
        isNotNull(schema.parentCalendarBlocks.title),
        scoped(schema.parentCalendarBlocks.familyId),
      ),
    );
  for (const row of blocks) {
    if (row.title === null) continue;
    add(row.familyId, {
      target: { kind: 'block', integrationId: row.integrationId, eventId: row.eventId },
      item: {
        ref: `block:${row.integrationId}:${row.eventId}`,
        source: 'google_calendar',
        integrationId: row.integrationId,
        itemKey: row.recurringEventId ?? row.eventId,
        title: row.title,
        startsAt: row.startAt?.toISOString() ?? null,
        place: null,
        sender: null,
      },
    });
  }

  const bookings = await database
    .select()
    .from(schema.activityBookings)
    .where(
      and(isNull(schema.activityBookings.cancelledAt), scoped(schema.activityBookings.familyId)),
    );
  for (const row of bookings) {
    add(row.familyId, {
      target: { kind: 'booking', id: row.id },
      item: {
        ref: `booking:${row.id}`,
        source: 'gmail',
        integrationId: row.integrationId,
        itemKey: row.messageId,
        title: row.title,
        startsAt: row.firstSessionAt.toISOString(),
        place: row.location,
        sender: row.providerHost,
      },
    });
  }

  return {
    byFamily,
    skippedDisconnected,
    skippedFamiliesPendingErasure: pendingErasureSkipped.size,
  };
}
