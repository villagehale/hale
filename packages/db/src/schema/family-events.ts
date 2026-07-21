import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { familyEventSourceEnum } from './enums.js';
import { families } from './families.js';
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
  },
  (table) => ({
    // The composer's read is WHERE family_id = ? AND starts_at IN [window] — index
    // the pair so a family's in-window scan is cheap.
    familyStartsIdx: index('family_events_family_starts_idx').on(table.familyId, table.startsAt),
  }),
);

export type FamilyEvent = typeof familyEvents.$inferSelect;
export type NewFamilyEvent = typeof familyEvents.$inferInsert;
