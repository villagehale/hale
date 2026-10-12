import { type Database, schema } from '@hale/db';
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { isParentRole } from '~/lib/channel/role-scope';
import type { SuppressReason } from '~/lib/loop/reminders/schedule';
import { seriesKeyForEvent } from './judge';
import { KID_HINT_MAX_CHARS, type KidRelevanceSource } from './skill-contract';

/**
 * "That's mine" (VIL-226 item 3, for the VIL-413 router). The parent's word that a
 * connector item is theirs, not the kids'.
 *
 * The target resolves to the item Hale tracks: a calendar SERIES (an instance alert goes
 * through its snapshot's series), or a Gmail message. Then, in one transaction:
 *   - a `parent` verdict of `adult`, which no model re-judge overwrites, holding the
 *     kind of thing it was as the judge's hint next time - never the title, and never a
 *     family memory fact, which the coach, the digest and a co-parent would read;
 *   - every live copy on the family calendar, past and future, soft-deleted, its title
 *     and place cleared, as the backfill drops an adult copy;
 *   - a held calendar alert for it dropped, and an open Gmail offer for it withdrawn, so
 *     nothing Hale still owes can name it later;
 *   - their scheduled reminders cancelled with `parent_untracked`;
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
   * when it repeats the item's own title or place. */
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

export interface ProviderItem {
  source: KidRelevanceSource;
  integrationId: string | null;
  itemKey: string;
}

/** A parent row is never matched against an input; it records who decided, not what. */
const PARENT_INPUT_HASH = 'parent';
const UNTRACK_REASON: SuppressReason = 'parent_untracked';

/** A removed copy keeps no parent words. `title` is NOT NULL, so it is emptied. */
export const CLEARED_EVENT_TEXT = { title: '', location: null, dutyOwnerLabel: null } as const;

const SERIES_ALERT_KEY = /^calendar_alert:([0-9a-f-]{36}):series:[^:]+:([^:]+):/;
const INSTANCE_ALERT_KEY = /^calendar_alert:([0-9a-f-]{36}):([^:]+):/;
const EMAIL_ALERT_KEY = /^email_alert:([0-9a-f-]{36}):(.+)$/;

/** The actor is not a parent of the family it asked to untrack for: an outsider, or a
 * caregiver, whose scope never covers a parent's own calendar. Nothing is written. */
export class UntrackActorNotParentError extends Error {
  override name = 'UntrackActorNotParentError';
}

export async function untrackItem(database: Database, input: UntrackInput): Promise<UntrackResult> {
  const [member] = await database
    .select({ role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, input.familyId),
        eq(schema.familyMembers.userId, input.actorUserId),
      ),
    );
  if (!member || !isParentRole(member.role)) {
    throw new UntrackActorNotParentError('untrackItem: actor is not a parent of the family');
  }

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
        location: schema.familyEvents.location,
        deletedAt: schema.familyEvents.deletedAt,
      })
      .from(schema.familyEvents)
      .where(
        and(
          eq(schema.familyEvents.familyId, input.familyId),
          or(eq(schema.familyEvents.kidVerdictId, verdict.id), eventsOf(item)),
        ),
      );
    const removed = matching.filter((row) => row.deletedAt === null).map((row) => row.id);

    if (removed.length > 0) {
      await tx
        .update(schema.familyEvents)
        .set({ deletedAt: input.now, ...CLEARED_EVENT_TEXT })
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

    await tx
      .update(table)
      .set({
        hint: safeKind(input.kind, [
          ...matching.flatMap((row) => [row.title, row.location].filter((text) => text !== null)),
          ...(await textsSeen(tx, item)),
        ]),
      })
      .where(eq(table.id, verdict.id));
    const { heldAlertsCleared, offersWithdrawn } = await dropOwedTexts(tx, item, input.now);
    await clearOfferWords(tx, item);

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
        heldAlertsCleared,
        offersWithdrawn,
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

/**
 * What Hale still owes the parent about this item, dropped when the item is judged the
 * parent's own - here and in the backfill's apply, so both leave nothing that names it.
 * A held calendar alert is dropped the way
 * the alert path drops an expired hold - the snapshot stays, so the next change is read
 * against the start Hale last saw, and only the held words go. An open Gmail offer is
 * withdrawn the way `withdrawEmailAlertOffer` does it (it stops being answerable); its
 * title is NOT NULL and is the text the parent already holds.
 */
export async function dropOwedTexts(
  database: Pick<Database, 'update'>,
  item: ProviderItem,
  now: Date,
): Promise<{ heldAlertsCleared: number; offersWithdrawn: number }> {
  if (item.integrationId === null) return { heldAlertsCleared: 0, offersWithdrawn: 0 };
  if (item.source === 'google_calendar') {
    const snapshots = schema.calendarEventSnapshots;
    const cleared = await database
      .update(snapshots)
      .set({
        pendingSince: null,
        heldTitle: null,
        heldLocation: null,
        heldMovedFromAt: null,
        heldMovedFromAllDay: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(snapshots.integrationId, item.integrationId),
          or(eq(snapshots.eventId, item.itemKey), eq(snapshots.recurringEventId, item.itemKey)),
          isNotNull(snapshots.pendingSince),
        ),
      )
      .returning({ eventId: snapshots.eventId });
    return { heldAlertsCleared: cleared.length, offersWithdrawn: 0 };
  }
  if (item.source === 'gmail') {
    const offers = schema.emailAlertOffers;
    const ofItem = and(
      eq(offers.integrationId, item.integrationId),
      eq(offers.messageId, item.itemKey),
    );
    const withdrawn = await database
      .update(offers)
      .set({ expiresAt: now })
      .where(and(ofItem, isNull(offers.resolvedAt), gt(offers.expiresAt, now)))
      .returning({ id: offers.id });
    return { heldAlertsCleared: 0, offersWithdrawn: withdrawn.length };
  }
  return { heldAlertsCleared: 0, offersWithdrawn: 0 };
}

/**
 * On the parent's own word, every Gmail offer of the item loses its words, resolved or
 * not. The backfill acts on a model verdict and keeps them, so its revert can put a Gmail
 * copy's title back.
 */
async function clearOfferWords(database: Pick<Database, 'update'>, item: ProviderItem) {
  if (item.source !== 'gmail' || item.integrationId === null) return;
  await database
    .update(schema.emailAlertOffers)
    .set({ title: '', location: null })
    .where(
      and(
        eq(schema.emailAlertOffers.integrationId, item.integrationId),
        eq(schema.emailAlertOffers.messageId, item.itemKey),
      ),
    );
}

/** The titles and places Hale held for this item outside the family calendar. */
async function textsSeen(
  database: Pick<Database, 'select'>,
  item: ProviderItem,
): Promise<string[]> {
  if (item.integrationId === null) return [];
  if (item.source === 'google_calendar') {
    const rows = await database
      .select({
        title: schema.calendarEventSnapshots.heldTitle,
        location: schema.calendarEventSnapshots.heldLocation,
      })
      .from(schema.calendarEventSnapshots)
      .where(
        and(
          eq(schema.calendarEventSnapshots.integrationId, item.integrationId),
          or(
            eq(schema.calendarEventSnapshots.eventId, item.itemKey),
            eq(schema.calendarEventSnapshots.recurringEventId, item.itemKey),
          ),
        ),
      );
    return rows.flatMap((row) => [row.title, row.location].filter((text) => text !== null));
  }
  if (item.source === 'gmail') {
    const rows = await database
      .select({
        title: schema.emailAlertOffers.title,
        location: schema.emailAlertOffers.location,
      })
      .from(schema.emailAlertOffers)
      .where(
        and(
          eq(schema.emailAlertOffers.integrationId, item.integrationId),
          eq(schema.emailAlertOffers.messageId, item.itemKey),
        ),
      );
    return rows.flatMap((row) => [row.title, row.location].filter((text) => text !== null));
  }
  return [];
}

/** The kind as one plain line, unless it is empty, long, or carries the item's own title
 * or place. */
function safeKind(kind: string | null, texts: readonly string[]): string | null {
  const trimmed = (kind ?? '').replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  if (trimmed.length === 0 || trimmed.length > KID_HINT_MAX_CHARS) return null;
  const folded = trimmed.toLowerCase();
  const leaks = texts.some((text) => {
    const own = text.trim().toLowerCase();
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
    return providerItemFromKey(database, input.familyId, message.dedupeKey);
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
      .where(
        and(
          eq(schema.kidRelevanceVerdicts.id, event.kidVerdictId),
          eq(schema.kidRelevanceVerdicts.familyId, input.familyId),
        ),
      );
    if (!verdict) return 'not_found';
    return {
      source: verdict.source,
      integrationId: verdict.integrationId,
      itemKey: verdict.itemKey,
    };
  }
  return 'not_provider_item';
}

/** The item an alert's key names, once the key's integration is this family's own. */
async function providerItemFromKey(
  database: Database,
  familyId: string,
  dedupeKey: string | null,
): Promise<ProviderItem | 'not_found' | 'not_provider_item'> {
  if (!dedupeKey) return 'not_provider_item';
  const keyed = (SERIES_ALERT_KEY.exec(dedupeKey) ??
    INSTANCE_ALERT_KEY.exec(dedupeKey) ??
    EMAIL_ALERT_KEY.exec(dedupeKey))?.[1];
  if (!keyed) return 'not_provider_item';
  const [integration] = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.id, keyed), eq(schema.integrations.familyId, familyId)));
  if (!integration) return 'not_found';
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
