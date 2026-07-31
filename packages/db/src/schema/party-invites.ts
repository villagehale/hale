import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { rsvpResponseEnum } from './enums.js';
import { families } from './families.js';
import { familyEvents } from './family-events.js';
import { users } from './users.js';

/**
 * VIL-245 · M10 — the shareable, ACCOUNT-LESS invite page behind one `family_events`
 * row. The host texts Hale a party; Hale mints one of these; the link goes out over
 * whatever the host already uses (iMessage, a class WhatsApp group), and 15–20
 * households who have never heard of Hale answer it without signing up for anything.
 *
 * The row is deliberately THIN. Everything about the party itself — what, when, where,
 * which child — lives in `family_events`, because a party is an occasion first and a
 * web page second: the weekly plan, the ICS feed and the reminder engine already read
 * that table, and a second copy of a start time is a second copy that can drift from
 * the one the calendar shows. This row adds only what a public page needs and an
 * occasion does not have: the token that addresses it, and whether it is still on.
 *
 * `publicToken` is 18 random bytes (144 bits) base64url — the same shape and the same
 * reasoning as the village share tokens (`village_candidates.share_token`). Not an
 * HMAC of the id: an HMAC is recomputable from the id by anything holding the key, and
 * carries the id's structure into a value strangers paste into group chats. Random has
 * no structure to leak and no key to rotate. It identifies no child and no parent, and
 * it is the page's ONLY handle — there is no enumerable id route.
 *
 * `hostUserId` is the parent who created it, and it is `notNull` for an operational
 * reason rather than a bookkeeping one: `channel_messages.parent_user_id` is NOT NULL,
 * so every guest-facing message this feature sends is ledgered against the host who
 * authorised it (the M6 caregiver-invite precedent — a stranger Hale texts on a
 * parent's say-so has no users row of their own).
 *
 * `cancelledAt` is a soft close, not a delete: a guest who opens the link after the
 * host cancels is shown that it is off, which is the whole point of having told them.
 */
export const partyInvites = pgTable(
  'party_invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The occasion this page is for. One page per party — enforced by the unique index. */
    familyEventId: uuid('family_event_id')
      .notNull()
      .references(() => familyEvents.id, { onDelete: 'cascade' }),
    /** The parent who asked for the link; the ledger attribution for every guest send. */
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** randomBytes(18).toString('base64url') — the page's only handle. */
    publicToken: text('public_token').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUniq: uniqueIndex('party_invites_public_token_uniq').on(table.publicToken),
    eventUniq: uniqueIndex('party_invites_event_uniq').on(table.familyEventId),
    familyIdx: index('party_invites_family_idx').on(table.familyId),
  }),
);

/**
 * VIL-245 · M10 — one guest's answer. The entire record Hale keeps about a person who
 * has no account, did not ask to hear from Hale, and never will unless they choose to.
 *
 * THE DATA MINIMISATION IS STRUCTURAL, NOT POLICY. A guest who does not ask for a
 * reminder leaves NO contact data behind at all: `reminder_opt_in_at` is null and the
 * two phone columns are null, and the table's CHECK constraint makes any other
 * combination unrepresentable. A future call site cannot "just also store the number" —
 * the database refuses the row. That is deliberate: this is third-party PII collected
 * at a moment of enthusiasm about someone else's birthday party, and the strongest
 * available guarantee is that the column is empty rather than that the code is careful.
 *
 * `reminderOptInAt` does triple duty on purpose — it is the flag, the CASL express-
 * consent timestamp, and the proof of when it was given. A separate boolean would be a
 * second thing that can disagree with it.
 *
 * `nameKey` is the lower-cased, whitespace-collapsed display name, and it is the
 * natural key one guest gets: opening the link twice and answering again UPDATES that
 * guest rather than adding a second head to the count. The tradeoff is explicit — two
 * different guests who type the identical name at one party collapse into one row —
 * and it is the right way round, because a person hitting back and re-submitting is
 * common and two identically-named guests at one child's party is rare, and the host
 * can see and correct the list either way.
 *
 * `reminderSentAt` is the day-before reminder's at-most-once ledger, claimed BEFORE the
 * send. The failure mode that choice buys is a missed reminder rather than a duplicate
 * text to a non-user, which is the correct direction for a message CASL only lets us
 * send once.
 */
export const partyRsvps = pgTable(
  'party_rsvps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyInviteId: uuid('party_invite_id')
      .notNull()
      .references(() => partyInvites.id, { onDelete: 'cascade' }),
    /** As the guest typed it. Not verified, not matched to anyone — a label, not a claim. */
    displayName: text('display_name').notNull(),
    /** Normalized `displayName` — the per-party natural key (see the note above). */
    nameKey: text('name_key').notNull(),
    response: rsvpResponseEnum('response').notNull(),
    /** Total people coming, including the guest. 1 when they answer for themselves. */
    headcount: integer('headcount').notNull().default(1),
    /** When the guest ticked "remind me" — the CASL express consent, or null. */
    reminderOptInAt: timestamp('reminder_opt_in_at', { withTimezone: true }),
    /** base64(iv ‖ authTag ‖ ciphertext) of the E.164. NULL unless they opted in. */
    phoneE164Encrypted: text('phone_e164_encrypted'),
    /** HMAC-SHA256 blind index — how a STOP from this number finds them. NULL unless
     * they opted in. */
    phoneE164Hash: text('phone_e164_hash'),
    /** Claimed before the day-before reminder is sent; at-most-once by construction. */
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // THE data-minimisation guarantee, in the database rather than in a code review:
    // no contact data may exist without the consent that permits holding it, and no
    // consent may be recorded without the number it was given for. Both directions,
    // because either half alone is a row that lies about what a guest agreed to.
    reminderConsentCheck: check(
      'party_rsvps_reminder_consent_check',
      sql`(${table.reminderOptInAt} IS NULL) = (${table.phoneE164Encrypted} IS NULL)
          AND (${table.reminderOptInAt} IS NULL) = (${table.phoneE164Hash} IS NULL)`,
    ),
    // A headcount is people. Zero is a "no" wearing a "yes", and a party of 200 from a
    // public form is someone testing the input, not a guest list.
    headcountCheck: check(
      'party_rsvps_headcount_check',
      sql`${table.headcount} >= 1 AND ${table.headcount} <= 20`,
    ),
    guestUniq: uniqueIndex('party_rsvps_invite_name_uniq').on(table.partyInviteId, table.nameKey),
    inviteIdx: index('party_rsvps_invite_idx').on(table.partyInviteId),
    // A STOP arrives as a bare number; this is how it resolves to the opt-ins it must
    // close. Partial: a guest who never opted in has no hash and is not in the index.
    phoneIdx: index('party_rsvps_phone_idx')
      .on(table.phoneE164Hash)
      .where(sql`${table.phoneE164Hash} IS NOT NULL`),
  }),
);

export type PartyInvite = typeof partyInvites.$inferSelect;
export type NewPartyInvite = typeof partyInvites.$inferInsert;
export type PartyRsvp = typeof partyRsvps.$inferSelect;
export type NewPartyRsvp = typeof partyRsvps.$inferInsert;
