import { date, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * The five item kinds a week plan surfaces (VIL-217). Fixed taxonomy — the
 * contract B2 (delivery/render) and B3 (calendar placement) consume:
 *   appointment — a health checkup / immunization window (privacy_sensitive)
 *   routine     — a condensed routine pattern (never 21 line-items)
 *   village     — a saved/accepted village activity dated in-window
 *   birthday    — a child's birthday OR a family-added occasion (family_events)
 *   suggestion  — the ONE ranked village pick, clearly a suggestion, never auto-scheduled
 */
export type WeekPlanItemKind = 'appointment' | 'routine' | 'village' | 'birthday' | 'suggestion';

/**
 * What the item asks of the parent — drives B2's rendering + B3's placement:
 *   none         — informational (a routine pattern, an existing birthday)
 *   calendar_add — Hale can add it to the calendar (a checkup to book, a dated activity)
 *   decision     — needs the parent's yes/no (the one suggestion)
 */
export type WeekPlanItemNeeds = 'none' | 'calendar_add' | 'decision';

/**
 * One composed item in a `week_plans.items` array — the typed union B2/B3 read.
 * Deliberately channel-agnostic: no rendered copy, only structured facts + flags.
 *
 * `startsAt`/`endsAt` are family-local calendar-day keys (`YYYY-MM-DD`), NOT
 * instants, and are NULL when the source is day-coarse (health due-windows are
 * month-granular — placing a checkup on a weekday would fabricate precision the
 * source doesn't have) or genuinely undated. `sourceRef` carries provenance so B3
 * can de-dup against calendar placements and never re-propose an actioned item.
 *
 * `privacySensitive` is TRUE on anything health-ish: B2's SMS renderer genericizes
 * these to "a checkup" regardless of the family's child-name level — health detail
 * NEVER rides SMS (F11 principle 2). It is independent of teen redaction, which is
 * applied to `title`/`childIds` at compose time via the deterministic age gate.
 */
export interface WeekPlanItem {
  kind: WeekPlanItemKind;
  /** Parent-facing item title. Already teen-redacted at compose time when it
   * concerns a 13+ child (generic, no name) — rule #1, deterministic age gate. */
  title: string;
  /** The children this item concerns. Empty for family-wide items. A teen-redacted
   * item keeps the id(s) for de-dup but carries a generic title + no name. */
  childIds: string[];
  /** Family-local start day `YYYY-MM-DD`, or null when day-coarse / undated. */
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  /** Provenance: the source table + row id, so B3 can join back and never
   * re-propose an item it already actioned. Null for derived items (birthdays). */
  sourceRef: { table: string; id: string } | null;
  needs: WeekPlanItemNeeds;
  privacySensitive: boolean;
}

/**
 * One composed weekly plan per family per week (VIL-217 — "the Sunday brain").
 * `week_start` is the Monday of the week the plan COVERS, as a family-local
 * calendar date (the composer runs Saturday night family-local and composes the
 * UPCOMING week). The unique (family_id, week_start) index makes a recompose upsert
 * the same row rather than duplicate it — idempotent until B2 delivers it, then B2
 * versions/flags via `status`.
 *
 * `summary` is the optional one-sentence LLM week summary (the composer's single
 * agent step). It is NULLABLE by design: the deterministic composer persists the
 * full `items` plan even when the LLM step is disabled or fails (graceful
 * degradation, rule #8) — the summary is simply omitted.
 *
 * Channel-agnostic: this artifact holds structured facts; B2 renders it (email /
 * SMS / in-app card + push), B3 acts on it. Empty weeks still compose (`items: []`)
 * — whether to send is B2's policy call, but the artifact always exists.
 */
export const weekPlans = pgTable(
  'week_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Monday of the covered week, family-local calendar date (`YYYY-MM-DD`). */
    weekStart: date('week_start').notNull(),
    composedAt: timestamp('composed_at', { withTimezone: true }).notNull().defaultNow(),
    /** The one-sentence LLM week summary, or null when the agent step is disabled /
     * failed (the deterministic plan still persists — rule #8). */
    summary: text('summary'),
    /** The typed item union B2/B3 consume. Defaults to an empty array so an empty
     * week is a real, queryable artifact (`items: []`), never a null. */
    items: jsonb('items').$type<WeekPlanItem[]>().notNull().default([]),
    /** Lifecycle: 'composed' (initial) → B2 sets 'delivered' / 'stale_delivered'
     * (a mid-week change recomposed after the Sunday text already went). Text (not
     * an enum) so B2 can extend the lifecycle without a migration. */
    status: text('status').notNull().default('composed'),
  },
  (table) => ({
    familyWeekIdx: uniqueIndex('week_plans_family_week_idx').on(table.familyId, table.weekStart),
  }),
);

export type WeekPlan = typeof weekPlans.$inferSelect;
export type NewWeekPlan = typeof weekPlans.$inferInsert;
