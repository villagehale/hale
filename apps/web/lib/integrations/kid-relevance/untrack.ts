import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { SuppressReason } from '~/lib/loop/reminders/schedule';
import { writeFact } from '~/lib/memory/facts';
import { NOT_KIDS_FACT_PREFIX, seriesKeyForEvent } from './judge';
import type { KidRelevanceSource } from './skill-contract';

/**
 * "That's mine" (VIL-226 item 3, for the VIL-413 router). The parent's word that a
 * connector item is theirs, not the kids'.
 *
 * The target resolves to the item Hale tracks: a calendar SERIES (an instance alert goes
 * through its snapshot's series), or a Gmail message. Then, in one transaction:
 *   - a `parent` verdict of `adult`, which no model re-judge overwrites;
 *   - every future copy on the family calendar soft-deleted;
 *   - their scheduled reminders cancelled with `parent_untracked`;
 *   - a `not-kids/<source>/<itemKey>` fact holding the kind of thing it was, so the
 *     judge reads it as a hint next time - never the title;
 *   - one audit row with the verdict, the source and the counts (rule #6).
 *
 * It returns facts only; the caller writes any reply. It has no caller until the intent
 * router lands.
 */

export interface UntrackInput {
  familyId: string;
  actorUserId: string;
  target: { kind: 'channel_message' | 'family_event'; id: string };
  now: Date;
  /** What kind of thing it was, as the router's model put it. Refused (stored as null)
   * when it repeats the item's own title. */
  kind: string | null;
}

export type UntrackResult =
  | {
      outcome: 'untracked';
      seenIn: KidRelevanceSource;
      cancelledReminders: number;
      removedEvents: number;
    }
  | { outcome: 'not_found' | 'not_provider_item' | 'already_untracked' };

interface ProviderItem {
  source: KidRelevanceSource;
  integrationId: string | null;
  itemKey: string;
}

/** A parent row is never matched against an input; it records who decided, not what. */
const PARENT_INPUT_HASH = 'parent';
const UNTRACK_REASON: SuppressReason = 'parent_untracked';

const SERIES_ALERT_KEY = /^calendar_alert:([0-9a-f-]{36}):series:[^:]+:([^:]+):/;
const INSTANCE_ALERT_KEY = /^calendar_alert:([0-9a-f-]{36}):([^:]+):/;
const EMAIL_ALERT_KEY = /^email_alert:([0-9a-f-]{36}):(.+)$/;

export async function untrackItem(database: Database, input: UntrackInput): Promise<UntrackResult> {
  const found = await resolveTarget(database, input);
  if (found === 'not_found' || found === 'not_provider_item') return { outcome: found };
  const item = found;

  const table = schema.kidRelevanceVerdicts;
  const identity = and(
    eq(table.familyId, input.familyId),
    eq(table.source, item.source),
    item.integrationId === null
      ? isNull(table.integrationId)
      : eq(table.integrationId, item.integrationId),
    eq(table.itemKey, item.itemKey),
  );
  const [existing] = await database.select().from(table).where(identity);
  if (existing?.decidedBy === 'parent' && existing.verdict === 'adult') {
    return { outcome: 'already_untracked' };
  }

  return database.transaction(async (tx) => {
    const [verdict] = await tx
      .insert(table)
      .values({
        familyId: input.familyId,
        source: item.source,
        integrationId: item.integrationId,
        itemKey: item.itemKey,
        inputHash: PARENT_INPUT_HASH,
        verdict: 'adult',
        decidedBy: 'parent',
        decidedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [table.familyId, table.source, table.integrationId, table.itemKey],
        set: {
          inputHash: PARENT_INPUT_HASH,
          verdict: 'adult',
          childId: null,
          teen: false,
          reason: null,
          decidedBy: 'parent',
          model: null,
          skillHash: null,
          decidedAt: input.now,
        },
      })
      .returning({ id: table.id });
    if (!verdict) throw new Error('untrackItem: verdict upsert returned no row');

    const matching = await tx
      .select({
        id: schema.familyEvents.id,
        title: schema.familyEvents.title,
        startsAt: schema.familyEvents.startsAt,
        deletedAt: schema.familyEvents.deletedAt,
      })
      .from(schema.familyEvents)
      .where(
        and(
          eq(schema.familyEvents.familyId, input.familyId),
          or(eq(schema.familyEvents.kidVerdictId, verdict.id), eventsOf(item)),
        ),
      );
    const removed = matching
      .filter((row) => row.deletedAt === null && row.startsAt >= input.now)
      .map((row) => row.id);

    if (removed.length > 0) {
      await tx
        .update(schema.familyEvents)
        .set({ deletedAt: input.now })
        .where(inArray(schema.familyEvents.id, removed));
    }
    const cancelled =
      removed.length === 0
        ? []
        : await tx
            .update(schema.eventReminders)
            .set({ status: 'cancelled', suppressReason: UNTRACK_REASON, updatedAt: input.now })
            .where(
              and(
                inArray(schema.eventReminders.eventRef, removed),
                eq(schema.eventReminders.status, 'scheduled'),
              ),
            )
            .returning({ id: schema.eventReminders.id });

    await writeFact(tx, {
      familyId: input.familyId,
      childId: null,
      factType: 'preference',
      factKey: `${NOT_KIDS_FACT_PREFIX}${item.source}/${item.itemKey}`,
      factValue: {
        kind: safeKind(
          input.kind,
          matching.map((row) => row.title),
        ),
      },
      confidence: 1,
      inferredBy: 'kid_relevance_untrack',
      validFrom: input.now,
    });

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.actorUserId,
      actionTaken: 'kid_relevance_untracked',
      targetTable: 'kid_relevance_verdicts',
      targetId: verdict.id,
      after: {
        verdict: 'adult',
        source: item.source,
        cancelledReminders: cancelled.length,
        removedEvents: removed.length,
      },
      occurredAt: input.now,
    });

    return {
      outcome: 'untracked' as const,
      seenIn: item.source,
      cancelledReminders: cancelled.length,
      removedEvents: removed.length,
    };
  });
}

/** The family_events rows that are copies of this provider item. */
function eventsOf(item: ProviderItem) {
  if (item.source === 'google_calendar' && item.integrationId !== null) {
    return and(
      eq(schema.familyEvents.integrationId, item.integrationId),
      or(
        eq(schema.familyEvents.googleEventId, item.itemKey),
        sql`${schema.familyEvents.googleEventId} in (select ${schema.calendarEventSnapshots.eventId}
          from ${schema.calendarEventSnapshots}
          where ${schema.calendarEventSnapshots.integrationId} = ${item.integrationId}
          and ${schema.calendarEventSnapshots.recurringEventId} = ${item.itemKey})`,
      ),
    );
  }
  if (item.source === 'gmail' && item.integrationId !== null) {
    return sql`${schema.familyEvents.id} in (select ${schema.emailAlertOffers.eventId}
      from ${schema.emailAlertOffers}
      where ${schema.emailAlertOffers.integrationId} = ${item.integrationId}
      and ${schema.emailAlertOffers.messageId} = ${item.itemKey}
      and ${schema.emailAlertOffers.eventId} is not null)`;
  }
  return sql`false`;
}

/** The kind, unless it is empty or carries the item's own title. */
function safeKind(kind: string | null, titles: readonly string[]): string | null {
  const trimmed = kind?.trim() ?? '';
  if (trimmed.length === 0) return null;
  const folded = trimmed.toLowerCase();
  const leaks = titles.some((title) => {
    const own = title.trim().toLowerCase();
    return own.length > 0 && (folded === own || folded.includes(own) || own.includes(folded));
  });
  return leaks ? null : trimmed;
}

async function resolveTarget(
  database: Database,
  input: UntrackInput,
): Promise<ProviderItem | 'not_found' | 'not_provider_item'> {
  if (input.target.kind === 'channel_message') {
    const [message] = await database
      .select({ dedupeKey: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.id, input.target.id),
          eq(schema.channelMessages.familyId, input.familyId),
        ),
      );
    if (!message) return 'not_found';
    return providerItemFromKey(database, message.dedupeKey);
  }

  const [event] = await database
    .select({
      id: schema.familyEvents.id,
      googleEventId: schema.familyEvents.googleEventId,
      integrationId: schema.familyEvents.integrationId,
      kidVerdictId: schema.familyEvents.kidVerdictId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, input.target.id),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    );
  if (!event) return 'not_found';
  if (event.googleEventId !== null && event.integrationId !== null) {
    return {
      source: 'google_calendar',
      integrationId: event.integrationId,
      itemKey: await seriesKeyForEvent(database, event.integrationId, event.googleEventId),
    };
  }
  const [offer] = await database
    .select({
      integrationId: schema.emailAlertOffers.integrationId,
      messageId: schema.emailAlertOffers.messageId,
    })
    .from(schema.emailAlertOffers)
    .where(
      and(
        eq(schema.emailAlertOffers.familyId, input.familyId),
        eq(schema.emailAlertOffers.eventId, event.id),
        isNotNull(schema.emailAlertOffers.eventId),
      ),
    );
  if (offer) {
    return { source: 'gmail', integrationId: offer.integrationId, itemKey: offer.messageId };
  }
  if (event.kidVerdictId !== null) {
    const [verdict] = await database
      .select()
      .from(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.id, event.kidVerdictId));
    if (verdict) {
      return {
        source: verdict.source,
        integrationId: verdict.integrationId,
        itemKey: verdict.itemKey,
      };
    }
  }
  return 'not_provider_item';
}

async function providerItemFromKey(
  database: Database,
  dedupeKey: string | null,
): Promise<ProviderItem | 'not_provider_item'> {
  if (!dedupeKey) return 'not_provider_item';
  const series = SERIES_ALERT_KEY.exec(dedupeKey);
  if (series?.[1] && series[2]) {
    return { source: 'google_calendar', integrationId: series[1], itemKey: series[2] };
  }
  const instance = INSTANCE_ALERT_KEY.exec(dedupeKey);
  if (instance?.[1] && instance[2]) {
    return {
      source: 'google_calendar',
      integrationId: instance[1],
      itemKey: await seriesKeyForEvent(database, instance[1], instance[2]),
    };
  }
  const email = EMAIL_ALERT_KEY.exec(dedupeKey);
  if (email?.[1] && email[2]) {
    return { source: 'gmail', integrationId: email[1], itemKey: email[2] };
  }
  return 'not_provider_item';
}
