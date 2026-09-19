import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * WHOSE MAIL HALE MAY READ — the per-family allowlist behind the forwarding address
 * (VIL-352 rung 3a).
 *
 * A forwarded message is a third party's document, not the parent's instruction, so the
 * default is that Hale does not read it. One in-thread YES per SENDER DOMAIN changes that,
 * and nothing else does. The row is the LIVE STATE the hot path reads; the matching
 * `consent_records` row is the legal record of the same YES. Two stores on purpose — the
 * split the SMS door already keeps, because a ledger is append-only and the question at
 * the door is "what is true right now".
 *
 * The `ref` is why this needs no `OpenQuestionKind`. The ask is sent with a `Reply-To` of
 * `hale+<token>.<ref>@`, so the address the parent replies to names the sender the answer
 * is about: a bare YES can never be claimed by, or stolen from, another open question.
 */
export const familyForwardSenders = pgTable(
  'family_forward_senders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The original sender's domain, lowercased. A family says yes to a school, not to
     * one address at it — and a school that sends from two domains is asked twice. */
    senderDomain: text('sender_domain').notNull(),
    /** The per-sender sub-tag that addresses the ask: 8 lowercase hex characters. */
    ref: text('ref').notNull(),
    /** THE ASK AS IT WAS SENT, held exactly while the question is open and nulled when it
     * is answered — by then the `consent_records` row carries it as the evidence of what
     * the parent was actually asked. Stored rather than re-rendered because a consent
     * record reconstructed from today's copy table is not the sentence anybody read. */
    askBody: text('ask_body'),
    /** 'pending' | 'allowed' | 'blocked' — text under a CHECK rather than an enum, so a
     * vocabulary change never needs an ALTER TYPE in a transaction that also writes it. */
    state: text('state').notNull(),
    /** Who decided. Its own SET NULL rather than a cascade: a parent leaving the
     * household does not un-decide what the household decided. */
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    domainUniq: uniqueIndex('family_forward_senders_domain_uniq').on(
      table.familyId,
      table.senderDomain,
    ),
    refUniq: uniqueIndex('family_forward_senders_ref_uniq').on(table.familyId, table.ref),
    // A decision is named and dated, or it has not happened. Half of one is a sender the
    // hot path would read as settled with nothing behind it.
    stateCheck: check(
      'family_forward_senders_state_check',
      sql`${table.state} IN ('pending', 'allowed', 'blocked')
	AND (${table.state} = 'pending') = (${table.decidedAt} IS NULL)`,
    ),
  }),
);

/**
 * THE RAW, and the only place a forwarded body is ever stored.
 *
 * A forward sits here exactly while the sender decision is pending — allow, block, or the
 * 72h lapse each delete it. Once a sender is allowed nothing raw is stored at all: the
 * body lives in the extraction call's stack frame and nowhere else. Plaintext, on the same
 * terms as an inbound `channel_messages.body`; the difference from that ledger is
 * LIFETIME, not exposure, and the privacy copy says exactly that.
 *
 * Family-scoped with a cascading FK, which IS the erasure path: runDeletionSweep issues
 * one DELETE FROM families and lets the cascade do the rest (rule #1, PIPEDA).
 */
export const emailForwardsPending = pgTable(
  'email_forwards_pending',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => familyForwardSenders.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    /** The address the forwarded document really came from — the school, not the parent
     * who forwarded it. */
    originalFrom: text('original_from').notNull(),
    subject: text('subject').notNull(),
    rawBody: text('raw_body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One held forward per message, belt and braces beside the channel_messages claim.
    providerMsgUniq: uniqueIndex('email_forwards_pending_provider_msg_uniq').on(
      table.providerMessageId,
    ),
    createdIdx: index('email_forwards_pending_created_idx').on(table.createdAt),
  }),
);

export type FamilyForwardSender = typeof familyForwardSenders.$inferSelect;
export type NewFamilyForwardSender = typeof familyForwardSenders.$inferInsert;
export type EmailForwardPending = typeof emailForwardsPending.$inferSelect;
export type NewEmailForwardPending = typeof emailForwardsPending.$inferInsert;
