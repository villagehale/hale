import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { consentRecords } from './consent.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * A parent's verified outbound channel — v1 is SMS (`kind = 'sms'`). This is the
 * loop's legal front door: nothing texts a parent until a row here is verified and
 * carries an SMS consent record (VIL-212 / CASL). The phone number is among the
 * most sensitive data we hold (rule #1), so it is stored ENCRYPTED at rest
 * (AES-256-GCM via APP_ENCRYPTION_KEY — the same envelope the integration token
 * vault uses) in `phone_e164_encrypted`, never in plaintext and never logged.
 *
 * Per-PARENT, not per-family: consent is the parent's own (rule #5 two-parent rule
 * is NOT triggered — co-parents enroll their own numbers independently).
 *
 * One ACTIVE channel per (user, kind): the partial unique index enforces at most
 * one row with `revoked_at IS NULL`. Enrollment revoke-then-inserts — a number
 * change or re-enroll soft-revokes the prior active row (kept for audit) and adds a
 * fresh one, so the row's own history plus audit_log + consent_records answer
 * "which number, when, under what consent" for PIPEDA right-to-access.
 *
 * `phone_e164_hash` is a deterministic keyed BLIND INDEX of the number (HMAC-SHA256
 * of the canonical E.164 — lib/crypto/blind-index). The encrypted blob uses a random
 * IV and so can't be searched by equality; the inbound-SMS webhook (A3) resolves an
 * incoming `From` → parent by this hash. A second partial unique index makes it
 * unambiguous among ACTIVE rows (at most one active channel per number) while revoked
 * rows keep their hash, so a recycled/re-enrolled number reconciles against history.
 */
export const parentChannels = pgTable(
  'parent_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Channel kind. Text (not an enum) so email/push kinds land additively later
     * without a CREATE TYPE. The app only ever writes 'sms' in v1. */
    kind: text('kind').notNull().default('sms'),
    /** base64(iv ‖ authTag ‖ ciphertext) of the E.164 number. Never plaintext. */
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    /** Deterministic keyed blind index (HMAC-SHA256 of the canonical E.164) — the
     * equality-searchable column the inbound webhook resolves `From` against. */
    phoneE164Hash: text('phone_e164_hash').notNull(),
    /** Set when OTP verification succeeds; null while a row is pending/legacy. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** The SMS consent record captured in the same transaction as the verify flip. */
    consentRecordId: uuid('consent_record_id').references(() => consentRecords.id),
    /** Soft-revoke: in-app toggle or STOP. A revoked row is kept for audit. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // At most one ACTIVE channel per parent per kind; revoked rows are unconstrained
    // history. The conflict target the enroll upsert never actually hits (we
    // revoke-then-insert), but it makes a double-active channel impossible.
    userKindActiveIdx: uniqueIndex('parent_channels_user_kind_active_idx')
      .on(table.userId, table.kind)
      .where(sql`${table.revokedAt} IS NULL`),
    // At most one ACTIVE channel per number → the inbound `From` lookup resolves to a
    // single parent. Partial (active only) so a revoked row keeps its hash for
    // reconciliation and a recycled number can be re-enrolled by its new holder.
    phoneHashActiveIdx: uniqueIndex('parent_channels_phone_hash_active_idx')
      .on(table.phoneE164Hash)
      .where(sql`${table.revokedAt} IS NULL`),
    userIdx: index('parent_channels_user_idx').on(table.userId),
  }),
);

export type ParentChannel = typeof parentChannels.$inferSelect;
export type NewParentChannel = typeof parentChannels.$inferInsert;
