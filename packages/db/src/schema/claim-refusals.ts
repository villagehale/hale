import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';

/** One claim the reader listed, and what code made of its citation. */
export interface ClaimRefusalClaim {
  segment: number;
  kind: string;
  /** The alias the reader cited (`e1`, `none`, …), never the row behind it. */
  cited: string;
  status: 'backed' | 'minted' | 'refused';
  reason?: string;
  why?: string;
}

/** What the reader was offered: a count per row source, and any slot's overflow. */
export interface ClaimRefusalCandidates {
  offered: Record<string, number>;
  capped: { slot: string; dropped: number }[];
}

/**
 * VIL-732 · the claim reader's verdict on a dispatch leg it refused (migration 0259),
 * kept beside the failed `channel_messages` row. No body and no row label travel: a
 * claim is its segment index, kind, cited alias and why. Erasure is the cascade from
 * the message row, and so from the family.
 */
export const claimRefusals = pgTable(
  'claim_refusals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    channelMessageId: uuid('channel_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    claims: jsonb('claims').$type<ClaimRefusalClaim[]>().notNull(),
    candidates: jsonb('candidates').$type<ClaimRefusalCandidates>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    channelMessageIdx: index('claim_refusals_channel_message_idx').on(table.channelMessageId),
    familyCreatedIdx: index('claim_refusals_family_created_idx').on(
      table.familyId,
      table.createdAt,
    ),
  }),
);

export type ClaimRefusal = typeof claimRefusals.$inferSelect;
