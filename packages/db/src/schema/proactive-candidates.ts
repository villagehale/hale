import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';

/**
 * VIL-226 · one proactive queue per family. Sweeps write a candidate here.
 * A decider later marks it sent, held, or dropped. The row is the evidence:
 * what, why, the page it came from, when it stops being worth saying, whether
 * the parent asked, and the dedupe key that keeps the same item from landing twice.
 */
export const PROACTIVE_CANDIDATE_STATUSES = [
  'queued',
  'held',
  'dropped',
  'sent',
  'shadowed',
] as const;
export type ProactiveCandidateStatus = (typeof PROACTIVE_CANDIDATE_STATUSES)[number];

export const proactiveCandidates = pgTable(
  'proactive_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    what: text('what').notNull(),
    why: text('why').notNull(),
    sourceUrl: text('source_url'),
    worthlessAfter: timestamp('worthless_after', { withTimezone: true }),
    parentRequested: boolean('parent_requested').notNull().default(false),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').notNull().default('queued').$type<ProactiveCandidateStatus>(),
    decision: text('decision'),
    reason: text('reason'),
    holdUntil: timestamp('hold_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => ({
    statusChk: check(
      'proactive_candidates_status_chk',
      sql`${table.status} IN ('queued', 'held', 'dropped', 'sent', 'shadowed')`,
    ),
    openIdx: index('proactive_candidates_open_idx')
      .on(table.familyId, table.createdAt)
      .where(sql`${table.status} IN ('queued', 'held')`),
  }),
);

export type ProactiveCandidate = typeof proactiveCandidates.$inferSelect;
export type NewProactiveCandidate = typeof proactiveCandidates.$inferInsert;
