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
import { families } from './families.js';
import { linqSharedGroupPeople } from './linq-multi-family.js';
import { users } from './users.js';

/**
 * VIL-686 — a Secret Santa drawn in a multi-family group, each draw sent to its giver 1:1.
 *
 * A draw belongs to ONE shared Linq chat. At most one is live (collecting or drawn) per
 * chat. The organizer is a shared-chat people row; their Hale family and user are kept so
 * the draw's audit rows still have a family after the organizer leaves the chat.
 */
export const SECRET_SANTA_STATUSES = ['collecting', 'drawn', 'cancelled'] as const;
export type SecretSantaStatus = (typeof SECRET_SANTA_STATUSES)[number];

/** Why a giver's draw has not gone yet. None of them refers to a receiver. */
export const SECRET_SANTA_HELD_REASONS = [
  'not_texted_hale',
  'opted_out',
  'opt_out_unread',
  'quiet_hours',
  'line_held',
  'cannot_open_1to1',
  'line_unwritten',
  'send_failed',
  'claim_stuck',
  'stopped',
  'draw_stale',
] as const;
export type SecretSantaHeldReason = (typeof SECRET_SANTA_HELD_REASONS)[number];

export const secretSantaDraws = pgTable(
  'secret_santa_draws',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: text('chat_id').notNull(),
    organizerPersonId: uuid('organizer_person_id').references(() => linqSharedGroupPeople.id, {
      onDelete: 'set null',
    }),
    organizerFamilyId: uuid('organizer_family_id').references(() => families.id, {
      onDelete: 'set null',
    }),
    organizerUserId: uuid('organizer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: text('status').$type<SecretSantaStatus>().notNull(),
    language: text('language'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    drawnAt: timestamp('drawn_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** A participant left or was erased after the draw: every undelivered giver is held. */
    staleAt: timestamp('stale_at', { withTimezone: true }),
    missingNotedAt: timestamp('missing_noted_at', { withTimezone: true }),
    staleNotedAt: timestamp('stale_noted_at', { withTimezone: true }),
  },
  (table) => ({
    liveChat: uniqueIndex('secret_santa_draws_live_chat_uniq')
      .on(table.chatId)
      .where(sql`${table.status} IN ('collecting', 'drawn')`),
    statusIdx: index('secret_santa_draws_status_idx').on(table.status, table.startedAt),
    statusCheck: check(
      'secret_santa_draws_status_check',
      sql`${table.status} IN ('collecting', 'drawn', 'cancelled')`,
    ),
    languageLength: check(
      'secret_santa_draws_language_length_check',
      sql`${table.language} IS NULL OR char_length(${table.language}) BETWEEN 1 AND 35`,
    ),
  }),
);

/**
 * `receiver_encrypted` is the only pointer from a giver to their receiver: the receiver's
 * participant id, encrypted, and not a foreign key (a foreign key column would itself be
 * the pairing in a row dump). Only `secret-santa-pairings.ts` reads or writes it, and it
 * is nulled the moment the draw is delivered.
 */
export const secretSantaParticipants = pgTable(
  'secret_santa_participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    drawId: uuid('draw_id')
      .notNull()
      .references(() => secretSantaDraws.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => linqSharedGroupPeople.id, { onDelete: 'cascade' }),
    called: text('called'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    receiverEncrypted: text('receiver_encrypted'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    heldReason: text('held_reason').$type<SecretSantaHeldReason>(),
  },
  (table) => ({
    drawPerson: uniqueIndex('secret_santa_participants_draw_person_uniq').on(
      table.drawId,
      table.personId,
    ),
    drawIdx: index('secret_santa_participants_draw_idx').on(table.drawId),
    personIdx: index('secret_santa_participants_person_idx').on(table.personId),
    calledLength: check(
      'secret_santa_participants_called_length_check',
      sql`${table.called} IS NULL OR char_length(${table.called}) BETWEEN 1 AND 40`,
    ),
    heldReasonCheck: check(
      'secret_santa_participants_held_reason_check',
      sql`${table.heldReason} IS NULL OR ${table.heldReason} IN ('not_texted_hale', 'opted_out', 'opt_out_unread', 'quiet_hours', 'line_held', 'cannot_open_1to1', 'line_unwritten', 'send_failed', 'claim_stuck', 'stopped', 'draw_stale')`,
    ),
  }),
);

export type SecretSantaDraw = typeof secretSantaDraws.$inferSelect;
export type SecretSantaParticipant = typeof secretSantaParticipants.$inferSelect;
