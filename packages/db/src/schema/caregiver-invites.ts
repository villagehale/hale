import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { familyRoleEnum } from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * VIL-241 · M6 — a caregiver invite in flight: the state row behind the DOUBLE
 * opt-in that has to happen before Hale texts anyone who is not a parent.
 *
 * Two separate people have to agree, and the row is what makes the gap between them
 * survivable: the PARENT authorizes disclosing a scoped slice to a named person on a
 * named number, and only then is the CAREGIVER asked, from their own phone, whether
 * they want it. Neither half is inferable from the other, so neither is inferred —
 * each writes its own consent_records row and this row records which half we are on.
 *
 * PII (rule #1): the caregiver's number is a third party's, held only because a
 * parent asked us to text it. It is stored exactly the way a parent's is —
 * `phone_hash` is the keyed blind index (equality-searchable, so an inbound `From`
 * resolves to the invite it answers) and `phone_encrypted` is the AES-GCM blob.
 * Nothing else about them is stored until they accept: `display_name` is the label
 * the PARENT used ("grandma"), not a claim about the person.
 *
 * `expires_at` is the 72h silence bound, RESET when the state advances — "either side
 * silent for 72 hours" is two clocks, not one, and an invite nobody answered must
 * lapse rather than sit open forever. Expiry is applied on READ (check-at-use), so a
 * missed sweep can never make a stale invite live.
 *
 * One OPEN invite per number (the partial unique index). Closed rows are kept: they
 * are the record of what was asked, of whom, and how it ended.
 */
export const caregiverInvites = pgTable(
  'caregiver_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The role being granted — the same enum family_members stores, so the scope the
     * caregiver is told about and the scope they end up with cannot diverge. */
    role: familyRoleEnum('role').notNull(),
    /** How the PARENT named them ("grandma"). Echoed back for confirmation only. */
    displayName: text('display_name').notNull(),
    /** base64(iv ‖ authTag ‖ ciphertext) of the E.164 number. Never plaintext. */
    phoneE164Encrypted: text('phone_e164_encrypted').notNull(),
    /** HMAC-SHA256 blind index of the canonical E.164 (lib/crypto/blind-index). */
    phoneE164Hash: text('phone_e164_hash').notNull(),
    /** The double opt-in's position (CaregiverInviteState in apps/web). Text, not an
     * enum: these are app-layer states that will churn while the flow is tuned. */
    state: text('state').notNull(),
    /** Set at acceptance — the users row minted for (or matched to) the caregiver. */
    caregiverUserId: uuid('caregiver_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneOpenIdx: uniqueIndex('caregiver_invites_phone_open_idx')
      .on(table.phoneE164Hash)
      .where(sql`${table.closedAt} IS NULL`),
    familyIdx: index('caregiver_invites_family_idx').on(table.familyId),
  }),
);

export type CaregiverInvite = typeof caregiverInvites.$inferSelect;
export type NewCaregiverInvite = typeof caregiverInvites.$inferInsert;
