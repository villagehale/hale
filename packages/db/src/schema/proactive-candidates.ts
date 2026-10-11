import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channelMessageCategoryEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-226 · one proactive queue per family. A sweep that would have texted writes a
 * candidate here instead; the hourly decider marks it sent, held, dropped or (in
 * shadow) shadowed. The row is the evidence: what, why, the page it came from, when it
 * stops being worth saying, whether the parent asked, and the dedupe key that keeps the
 * same item from landing twice.
 *
 * `parent_user_id`, `category`, `template_key` and `dedupe_key` are the ledger identity
 * the sweep would have written to `channel_messages`. The decider's send writes that
 * row with them, so the sweep's own dedupe and the open-question readers see the send.
 *
 * The family cascade is the erasure path; the user cascade covers a departed parent.
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
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The outbound-gate class (`ProactiveSendKind`) the send is re-gated under. */
    kind: text('kind').notNull(),
    category: channelMessageCategoryEnum('category').notNull(),
    templateKey: text('template_key').notNull(),
    what: text('what').notNull(),
    why: text('why').notNull(),
    sourceUrl: text('source_url'),
    worthlessAfter: timestamp('worthless_after', { withTimezone: true }),
    parentRequested: boolean('parent_requested').notNull().default(false),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').notNull().default('queued').$type<ProactiveCandidateStatus>(),
    /** The decider's own action: send_now, hold, or drop. */
    decision: text('decision'),
    /** Why the row is where it is. A named code or the decider's one-line reason. */
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
    dedupeUnique: uniqueIndex('proactive_candidates_dedupe_idx').on(
      table.familyId,
      table.dedupeKey,
    ),
    openIdx: index('proactive_candidates_open_idx')
      .on(table.familyId, table.createdAt)
      .where(sql`${table.status} IN ('queued', 'held')`),
  }),
);

export type ProactiveCandidate = typeof proactiveCandidates.$inferSelect;
export type NewProactiveCandidate = typeof proactiveCandidates.$inferInsert;
