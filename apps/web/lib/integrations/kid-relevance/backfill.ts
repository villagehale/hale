import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { SuppressReason } from '~/lib/loop/reminders/schedule';
import {
  type KidJudgement,
  judgeKidRelevance,
  loadKidRelevanceChildren,
  loadNotMineHints,
  seriesKeyForEvent,
} from './judge';
import type { KidRelevanceItem, KidRelevanceSource } from './skill-contract';

/**
 * The one-off kid-relevance backfill (VIL-226 item 5).
 *
 * Judges what Hale already holds from connectors - mirrored Google events, family events
 * a parent added from a Gmail offer, parent calendar blocks flagged as kid-related, and
 * live activity bookings - and, with `apply`:
 *   - soft-deletes every adult family event and cancels its scheduled reminders with
 *     `kid_relevance_backfill`, one audit row each (rule #6);
 *   - clears `kid_related` and the title on an adult parent block;
 *   - links each judged event to its verdict (and its child when the event had none), so
 *     the reminder gate can read it.
 * Adult activity bookings are only counted (founder default D10). `unsure` and held items
 * are counted and left alone: not dropped and not linked, so the live gate judges them
 * again on its own terms.
 *
 * A dry run changes no tracking state and writes no audit row. It does store the verdicts
 * themselves, so the apply that follows judges nothing again and acts on exactly the
 * verdicts the dry run counted. It returns counts only (rule #1).
 */

export interface BackfillInput {
  apply: boolean;
  now: Date;
  deadline: Date;
  /** Restrict to these families; every family with connector rows when omitted. */
  familyIds?: readonly string[];
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
}

const BACKFILL_REASON: SuppressReason = 'kid_relevance_backfill';

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
  };

  const byFamily = await loadCandidates(database, input.familyIds);
  for (const [familyId, candidates] of byFamily) {
    counts.families += 1;
    const judged = await judgeKidRelevance(
      database,
      { familyId, items: candidates.map((c) => c.item), now: input.now, deadline: input.deadline },
      {
        client: ports.client,
        children: await loadKidRelevanceChildren(database, familyId),
        notMineHints: await loadNotMineHints(database, familyId),
      },
    );
    const verdictByRef = new Map(judged.map((judgement) => [judgement.ref, judgement]));

    const adultEvents: { id: string; source: KidRelevanceSource }[] = [];
    const adultBlocks: { integrationId: string; eventId: string; source: KidRelevanceSource }[] =
      [];
    const links: { eventId: string; judgement: Extract<KidJudgement, { verdictId: string }> }[] =
      [];
    for (const candidate of candidates) {
      const judgement = verdictByRef.get(candidate.item.ref);
      if (!judgement) throw new Error('kid-relevance backfill: an item came back unjudged');
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
          adultEvents.push({ id: candidate.target.id, source: candidate.item.source });
        }
      } else if (candidate.target.kind === 'block') {
        if (judgement.verdict === 'adult') {
          adultBlocks.push({ ...candidate.target, source: candidate.item.source });
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
    counts.eventsDropped += adultEvents.length;
    counts.remindersCancelled += scheduled.length;
    counts.blocksCleared += adultBlocks.length;
    if (!input.apply) continue;

    await database.transaction(async (tx) => {
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
          .set({ deletedAt: input.now })
          .where(
            inArray(
              schema.familyEvents.id,
              adultEvents.map((event) => event.id),
            ),
          );
        await tx.insert(schema.auditLog).values(
          adultEvents.map((event) => ({
            familyId,
            actor: 'system',
            actionTaken: 'kid_relevance_event_dropped',
            targetTable: 'family_events',
            targetId: event.id,
            after: { verdict: 'adult', source: event.source, reason: BACKFILL_REASON },
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
            after: { reason: BACKFILL_REASON },
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
        await tx.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'kid_relevance_event_dropped',
          targetTable: 'parent_calendar_blocks',
          targetId: `${block.integrationId}:${block.eventId}`,
          after: { verdict: 'adult', source: block.source, reason: BACKFILL_REASON },
          occurredAt: input.now,
        });
      }
    });
  }
  return counts;
}

async function loadCandidates(
  database: Database,
  familyIds: readonly string[] | undefined,
): Promise<Map<string, Candidate[]>> {
  const byFamily = new Map<string, Candidate[]>();
  // An offer or a booking names its connection without a foreign key, so it can outlive
  // a disconnect; a verdict cannot, because its integration_id cascades.
  const connected = new Set(
    (await database.select({ id: schema.integrations.id }).from(schema.integrations)).map(
      (row) => row.id,
    ),
  );
  const add = (familyId: string, candidate: Candidate) => {
    if (familyIds && !familyIds.includes(familyId)) return;
    if (candidate.item.integrationId !== null && !connected.has(candidate.item.integrationId)) {
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
      and(eq(schema.emailAlertOffers.resolution, 'added'), isNull(schema.familyEvents.deletedAt)),
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
    .where(isNull(schema.activityBookings.cancelledAt));
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

  return byFamily;
}
