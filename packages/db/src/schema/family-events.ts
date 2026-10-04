import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { familyEventSourceEnum } from './enums.js';
import { families } from './families.js';
import { integrations } from './integrations.js';
import { users } from './users.js';

/**
 * The loop's shared "external events" home (VIL-217) — occasions that have no other
 * model in Hale: a friend's birthday party, a family gathering, a swim meet. The
 * weekly-plan composer READS any rows in-window here (as `birthday`-kind items); the
 * WRITE paths land later — C2 turns a channel reply ("add Leo's party Sat 2pm") into
 * a row, and the E-phase pulls them from invite emails. `source` records which.
 *
 * `startsAt` is the event's start INSTANT (timestamptz). The composer buckets an
 * event into a week by its FAMILY-LOCAL calendar day — `dayKeyIn(startsAt, familyTz)`
 * — so an event stored at a UTC instant lands on the correct local day across DST and
 * zones. An all-day occasion (a birthday party with no stated time) is stored at the
 * family-local start-of-day instant by the write path. `endsAt` is optional (a point
 * event has none).
 *
 * Family-scoped by construction (rule #1): every read is keyed on `family_id`, and
 * the FK cascades on family deletion. `childId` is nullable — set when the event
 * concerns one child (so the composer can apply the teen age gate to it), null for a
 * family-wide occasion.
 */
export const familyEvents = pgTable(
  'family_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The child this event concerns, or null for a family-wide occasion. Nulled
     * (not deleted) if the child is removed — the event itself survives. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** Event start INSTANT; the composer reads its family-local day via dayKeyIn. */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    location: text('location'),
    source: familyEventSourceEnum('source').notNull(),
    /** Privacy-sensitive (health) — set by the calendar_add executor from the week_plan
     * item's privacySensitive (VIL-223). The reminder templates read it to genericize
     * the copy ("a checkup", never the detail) for EVERYONE, independent of the teen
     * age gate (which remains the floor on top). Defaults false; pre-signal placement
     * rows read false (backfill note). */
    sensitive: boolean('sensitive').notNull().default(false),
    /** The parent who added it (users.id), or null for a channel/email-sourced row
     * with no acting user. Nulled if the user is deleted — the event survives. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-delete stamp (VIL-219): a `calendar_cancel` marks the placement deleted
     * here rather than erasing the row, so the audit trail + provenance survive (rules
     * #6/#9) and an UNDO stays reversible. Every read that surfaces a live event — the
     * composer's listFamilyEventsInWindow, the ICS feed, the reviewer conflict check —
     * filters `deleted_at IS NULL`. Null = a live placement/occasion. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** The calendar_add action that placed this row, or null for every row no action
     * placed (parent-authored, email-sourced). The INSERT carrying it is the executor's
     * idempotency claim — the partial unique index below makes a concurrent or
     * redelivered placement of the same action conflict instead of double-placing
     * (migration 0106; the outbound_sends idiom on this table). Deliberately no FK:
     * the stamp is a claim key, and both tables already cascade on family deletion. */
    placedByActionId: uuid('placed_by_action_id'),
    /**
     * VIL-383. Who currently owns this kid occasion. Overwritten in place;
     * the previous owner stays in `audit_log` and in the superseded duty
     * fact. Null until a duty is confirmed. Not a Google Calendar write.
     */
    dutyOwnerUserId: uuid('duty_owner_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Spoken first name, or a named non-parent ("Grandma"). Null for "both". */
    dutyOwnerLabel: text('duty_owner_label'),
    /** parent | named | both. Null when no duty is attached. */
    dutyOwnerKind: text('duty_owner_kind'),
    /** dropoff | pickup | attend. */
    dutyRole: text('duty_role'),
    /** Live `duty/…` fact key this projection came from. */
    dutyFactKey: text('duty_fact_key'),
    dutySetAt: timestamp('duty_set_at', { withTimezone: true }),
    /**
     * Google's event id when this row is a mirror of the parent's own calendar
     * (VIL-416). Null on every Hale-authored row (a placement, a YES, a channel
     * add). Set together with `integrationId`. The reminder cron reminds only
     * the connecting parent, and a second mirror of the same Google event
     * conflicts here instead of scheduling a second pair of reminders.
     */
    googleEventId: text('google_event_id'),
    /** The gcal connection this mirror was read from. Null on Hale-authored rows.
     * Deleting the connection takes the mirror (and its reminders) with it. */
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'cascade',
    }),
  },
  (table) => ({
    // The composer's read is WHERE family_id = ? AND starts_at IN [window] — index
    // the pair so a family's in-window scan is cheap.
    familyStartsIdx: index('family_events_family_starts_idx').on(table.familyId, table.startsAt),
    // One placement per action — the claim's arbiter (migration 0106).
    placedByActionUniq: uniqueIndex('family_events_placed_by_action_uniq')
      .on(table.placedByActionId)
      .where(sql`${table.placedByActionId} IS NOT NULL`),
    dutyFactIdx: index('family_events_duty_fact_idx')
      .on(table.familyId, table.dutyFactKey)
      .where(sql`${table.dutyFactKey} IS NOT NULL`),
    googleEventUniq: uniqueIndex('family_events_google_event_uniq')
      .on(table.integrationId, table.googleEventId)
      .where(sql`${table.googleEventId} IS NOT NULL`),
  }),
);

export type FamilyEvent = typeof familyEvents.$inferSelect;
export type NewFamilyEvent = typeof familyEvents.$inferInsert;
