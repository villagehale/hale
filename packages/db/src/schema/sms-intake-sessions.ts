import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-237 · M2 — the conversational SMS intake's state carrier, keyed by the phone
 * number ALONE (there is no account yet: the number becomes the account).
 *
 * The state is STORED, never inferred from the transcript. A message-shaped guess
 * ("their second reply must be the postal code") breaks the moment a parent sends
 * two texts, answers out of order, or a delivery retries — so every branch of the
 * machine reads `state` and writes the next one, and a duplicate inbound is caught
 * by `last_provider_id` rather than by re-reading history.
 *
 * PII (rule #1): the raw number is never stored — `phone_hash` is the same keyed
 * blind index parent_channels uses (equality-searchable), `phone_encrypted` is the
 * AES-GCM blob provisioning needs to write the channel. `data_encrypted` is the
 * envelope-encrypted intake payload: the accumulated extraction (child names, ages,
 * postal code) plus the message transcript. That is child PII gathered BEFORE any
 * family or consent row exists, so it is encrypted at rest here and replayed into
 * channel_messages the moment provisioning gives it a family to belong to.
 *
 * One OPEN session per number (the partial unique index). Closed sessions are kept:
 * they are the record of how a family arrived, and PIPEDA right-to-access reads it.
 */
export const smsIntakeSessions = pgTable(
  'sms_intake_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** HMAC-SHA256 blind index of the canonical E.164 (lib/crypto/blind-index). */
    phoneHash: text('phone_hash').notNull(),
    /** base64(iv ‖ authTag ‖ ciphertext) of the E.164 number. Never plaintext. */
    phoneEncrypted: text('phone_encrypted').notNull(),
    /** The intake state machine's current state (IntakeState in apps/web). Text, not
     * an enum: the states are an app-layer concern that will churn while the flow is
     * tuned, and a CREATE TYPE per iteration buys nothing the app doesn't check. */
    state: text('state').notNull(),
    /** The QR venue code carried on the prefilled first message, if any. */
    sourceCode: text('source_code'),
    /** Envelope-encrypted JSON: `{ collected, transcript }` (see module header). */
    dataEncrypted: text('data_encrypted').notNull(),
    /** How many targeted follow-ups have been asked. Hard-capped at one. */
    followUpCount: integer('follow_up_count').notNull().default(0),
    /** How many watch-offer clarifications have been asked. Hard-capped at one. */
    clarifyCount: integer('clarify_count').notNull().default(0),
    /**
     * VIL-324 — the next-morning sitting-session reminder. Claimed BEFORE the send
     * (party-reminder shape), and deliberately NOT follow_up_count: that counter is
     * the same-thread incomplete-details ask. This is a later, scheduled text.
     */
    sittingReminderSentAt: timestamp('sitting_reminder_sent_at', { withTimezone: true }),
    /** Set at provisioning; null while the session is still pre-family. */
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** The provider id of the last inbound handled — the idempotency guard that makes
     * a carrier's webhook retry a no-op instead of a second reply. */
    lastProviderId: text('last_provider_id'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneOpenIdx: uniqueIndex('sms_intake_sessions_phone_open_idx')
      .on(table.phoneHash)
      .where(sql`${table.closedAt} IS NULL`),
    providerIdx: index('sms_intake_sessions_provider_idx').on(table.lastProviderId),
  }),
);

export type SmsIntakeSession = typeof smsIntakeSessions.$inferSelect;
export type NewSmsIntakeSession = typeof smsIntakeSessions.$inferInsert;
