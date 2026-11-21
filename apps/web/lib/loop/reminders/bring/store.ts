import { type BringItemsSourceKind, type Database, schema } from '@hale/db';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';

/**
 * VIL-720 · where what to bring is kept: `family_event_bring_items` (migration 0259).
 *
 * ONE PARENT'S, ALWAYS. Every row names the parent whose own mailbox or 1:1 thread carried
 * the source, and {@link loadBringItemsFor} returns rows for that parent alone. The 1:1
 * reminder is the only reader, so the items never reach the co-parent who hears the same
 * event's reminder, a caregiver, or a group (CLAUDE.md rule #1, the handoff's group
 * privacy rule). Only the items are stored, never the email or flyer they came from.
 *
 * Every write that keeps or attaches items leaves an audit_log row with counts only, never
 * the items (rule #6; an audit row a support agent can read is not a copy of a parent's
 * mail). The stale-pending cleanup is retention, not an action, and writes none.
 */

/** The provider message an item list came from: the same `(integration, message)` pair the
 * email alert offer is keyed on, so a parent's yes to that offer finds its list. */
export function bringSourceRef(integrationId: string, messageId: string): string {
  return `${integrationId}:${messageId}`;
}

/**
 * A pending list is one whose occasion was offered and not yet placed. An offer stands at
 * most a day (EMAIL_ALERT_OFFER_TTL_MS), so a pending list older than two days can never be
 * attached, and is deleted the next time this parent's lists are written.
 */
export const BRING_PENDING_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Whether this parent already has a list read from this source (a re-run sweep, a
 * re-offered hold): the read is not paid for twice. */
export async function bringItemsAlreadyRead(
  database: Database,
  input: { ownerUserId: string; sourceRef: string },
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.familyEventBringItems.id })
    .from(schema.familyEventBringItems)
    .where(
      and(
        eq(schema.familyEventBringItems.ownerUserId, input.ownerUserId),
        eq(schema.familyEventBringItems.sourceRef, input.sourceRef),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export type RecordBringItemsOutcome = 'recorded' | 'already_recorded' | 'empty';

/**
 * Keep a reading. `eventId` null keeps it pending on its offer (see
 * {@link attachPendingBringItems}). One list per source per parent: a second write for the
 * same source changes nothing (`already_recorded`).
 */
export async function recordBringItems(
  database: Database,
  input: {
    familyId: string;
    ownerUserId: string;
    eventId: string | null;
    sourceKind: BringItemsSourceKind;
    sourceRef: string;
    items: readonly string[];
    now: Date;
  },
): Promise<RecordBringItemsOutcome> {
  if (input.items.length === 0) return 'empty';
  return database.transaction(async (tx) => {
    await tx
      .delete(schema.familyEventBringItems)
      .where(
        and(
          eq(schema.familyEventBringItems.ownerUserId, input.ownerUserId),
          isNull(schema.familyEventBringItems.eventId),
          lt(
            schema.familyEventBringItems.createdAt,
            new Date(input.now.getTime() - BRING_PENDING_MAX_AGE_MS),
          ),
        ),
      );
    const [row] = await tx
      .insert(schema.familyEventBringItems)
      .values({
        familyId: input.familyId,
        ownerUserId: input.ownerUserId,
        eventId: input.eventId,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        items: [...input.items],
        createdAt: input.now,
        attachedAt: input.eventId === null ? null : input.now,
      })
      .onConflictDoNothing({
        target: [schema.familyEventBringItems.ownerUserId, schema.familyEventBringItems.sourceRef],
      })
      .returning({ id: schema.familyEventBringItems.id });
    if (!row) return 'already_recorded';
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'bring_items_recorded',
      audience: input.ownerUserId,
      targetTable: 'family_event_bring_items',
      targetId: row.id,
      after: {
        source: input.sourceKind,
        count: input.items.length,
        onEvent: input.eventId !== null,
      },
    });
    return 'recorded';
  });
}

/**
 * The parent said yes and the offered occasion is now `eventId`: its pending list, read
 * from the same source, is attached to it. Guarded on `event_id IS NULL`, so a redriven yes
 * attaches once and writes one audit row. Returns how many lists were attached (0 or 1).
 */
export async function attachPendingBringItems(
  database: Database,
  input: {
    familyId: string;
    ownerUserId: string;
    sourceRef: string;
    eventId: string;
    now: Date;
  },
): Promise<number> {
  return database.transaction(async (tx) => {
    const attached = await tx
      .update(schema.familyEventBringItems)
      .set({ eventId: input.eventId, attachedAt: input.now })
      .where(
        and(
          eq(schema.familyEventBringItems.familyId, input.familyId),
          eq(schema.familyEventBringItems.ownerUserId, input.ownerUserId),
          eq(schema.familyEventBringItems.sourceRef, input.sourceRef),
          isNull(schema.familyEventBringItems.eventId),
        ),
      )
      .returning({
        id: schema.familyEventBringItems.id,
        sourceKind: schema.familyEventBringItems.sourceKind,
        items: schema.familyEventBringItems.items,
      });
    for (const row of attached) {
      await tx.insert(schema.auditLog).values({
        familyId: input.familyId,
        actor: input.ownerUserId,
        actionTaken: 'bring_items_attached',
        audience: input.ownerUserId,
        targetTable: 'family_event_bring_items',
        targetId: row.id,
        after: { source: row.sourceKind, count: row.items.length },
      });
    }
    return attached.length;
  });
}

function itemKey(item: string): string {
  return (item.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

/**
 * The lists THIS parent may hear, per event, oldest source first, repeats dropped. An event
 * with no list is absent from the map. Never another parent's rows: `ownerUserId` is in the
 * query, not filtered after it.
 */
export async function loadBringItemsFor(
  database: Database,
  input: { familyId: string; ownerUserId: string; eventIds: readonly string[] },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (input.eventIds.length === 0) return out;
  const rows = await database
    .select({
      eventId: schema.familyEventBringItems.eventId,
      items: schema.familyEventBringItems.items,
    })
    .from(schema.familyEventBringItems)
    .where(
      and(
        eq(schema.familyEventBringItems.familyId, input.familyId),
        eq(schema.familyEventBringItems.ownerUserId, input.ownerUserId),
        inArray(schema.familyEventBringItems.eventId, [...input.eventIds]),
      ),
    )
    .orderBy(asc(schema.familyEventBringItems.createdAt), asc(schema.familyEventBringItems.id));
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.eventId === null || !Array.isArray(row.items)) continue;
    const list = out.get(row.eventId) ?? [];
    const keys = seen.get(row.eventId) ?? new Set<string>();
    for (const item of row.items) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      const key = itemKey(trimmed);
      if (key === '' || keys.has(key)) continue;
      keys.add(key);
      list.push(trimmed);
    }
    if (list.length > 0) {
      out.set(row.eventId, list);
      seen.set(row.eventId, keys);
    }
  }
  return out;
}
