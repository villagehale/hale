import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { actions } from './actions.js';
import { conversations } from './conversations.js';
import {
  channelMessageCategoryEnum,
  channelMessageChannelEnum,
  channelMessageDirectionEnum,
  channelMessageStatusEnum,
} from './enums.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * F11 · The Sunday Loop — channel_messages (VIL-213 · A2). The NEW operational
 * system-of-record for LOOP messages only, in both directions and for EVERY
 * outcome (a delivered/failed send OR a suppression). One row per delivery leg.
 *
 * Relationship to the existing ledgers (scout decision, do not blur):
 *   - email_sends stays the CASL legal sub-ledger — a loop EMAIL writes BOTH this
 *     row and an email_sends row (and honors the email opt-out).
 *   - outbound_sends (executor exactly-once) is a different domain and is
 *     UNTOUCHED.
 *
 * `body` is nullable and populated for direction:'in' ONLY — the verbatim inbound
 * reply, which C3 treats as the approval's legal instrument (locked cross-ticket
 * contract). Outbound rows never store a rendered body: it is reconstructable from
 * template + payload, and storing rendered child-data is a liability (rule #1).
 */

/**
 * Which fixed line answered an inbound text that Hale declined to take on
 * (VIL-273). Set on the INBOUND row, and null on every message the coach actually
 * answered — so "how often does Hale say no, and to what" is one indexed scan.
 *
 * The values are the lanes the screening skill chooses between, minus `in_domain`:
 * an in-domain message leaves both columns null, because a question Hale answered is
 * not an unmet intent.
 */
export const UNMET_INTENT_LANES = [
  'off_domain_general',
  'safety_critical',
  'provider_access',
] as const;

export type UnmetIntentLane = (typeof UNMET_INTENT_LANES)[number];

/**
 * WHAT the parent wanted, as a bucket — never as words they typed.
 *
 * A closed vocabulary is the structural half of rule #1 here: the value is produced by
 * a model reading a family's private message, and the only way a name or a symptom can
 * never reach a founder's weekly email is for the column to be incapable of holding
 * one. `other` is the escape hatch, and its own count is the signal that the list needs
 * a new entry.
 *
 * THIS ARRAY IS THE SOURCE. The type is derived from it, the screen's runtime allowlist
 * imports it, and migration 0080's CHECK constraint restates it in SQL — which is the
 * one copy TypeScript cannot own, so `unmet-vocabulary-consistency.test.mjs` holds the
 * two together mechanically. Adding a bucket is deliberately a migration.
 */
export const UNMET_INTENT_CATEGORIES = [
  'weather',
  'news-or-politics',
  'general-knowledge',
  'nearby-places',
  'traffic-or-transit',
  'shopping-or-deals',
  'other',
  'medical-symptom',
  'mental-health',
  'child-safety',
  'emergency',
  'doctor-access',
  'specialist-access',
] as const;

export type UnmetIntentCategory = (typeof UNMET_INTENT_CATEGORIES)[number];

/**
 * Where the words in a medical-symptom answer came from: the composed, searched reply, or
 * the fixed 811/911 line taken after a live attempt and a retry both failed.
 *
 * THIS ARRAY IS THE SOURCE, on the same terms as the unmet vocabulary above: the composer
 * derives its own type from it, and migration 0090's CHECK restates it in SQL — the one
 * copy TypeScript cannot own, held to this one by
 * `unmet-vocabulary-consistency.test.mjs`. Two values and no third: this column is read
 * by the founder scorecard's SAFETY row, so a value it does not understand would be
 * counted as neither an answer nor a fallback.
 */
export const MEDICAL_REPLY_SOURCES = ['web_grounded', 'fixed'] as const;

export type MedicalReplySourceValue = (typeof MEDICAL_REPLY_SOURCES)[number];
export const channelMessages = pgTable(
  'channel_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: channelMessageChannelEnum('channel').notNull(),
    direction: channelMessageDirectionEnum('direction').notNull().default('out'),
    category: channelMessageCategoryEnum('category').notNull(),
    /** The template that produced (or would have produced) this message. Null for
     * inbound replies, which have no template. */
    templateKey: text('template_key'),
    /** Natural-identity idempotency key (e.g. family+week+template). Unique where
     * present, so a re-drain can never double-send the same logical message. */
    dedupeKey: text('dedupe_key'),
    /** The provider's id for the send. Indexed — A3's delivery-status callbacks
     * update `status` by looking a row up on it. */
    providerMessageId: text('provider_message_id'),
    status: channelMessageStatusEnum('status').notNull(),
    errorCode: text('error_code'),
    /** Verbatim body — direction:'in' ONLY (A3 writes it; C3's legal instrument).
     * Outbound rows leave this null (rule #1). */
    body: text('body'),
    relatedActionId: uuid('related_action_id').references(() => actions.id, {
      onDelete: 'set null',
    }),
    relatedConversationId: uuid('related_conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** The lane that answered this inbound text without waking the coach, or null when
     * nothing did. Always written together with {@link channelMessages.unmetCategory} —
     * a DB check constraint refuses the half-filled pair. */
    unmetLane: text('unmet_lane').$type<UnmetIntentLane>(),
    /** The demand-signal bucket (see {@link UnmetIntentCategory}). Never free text. */
    unmetCategory: text('unmet_category').$type<UnmetIntentCategory>(),
    /** OUTBOUND medical-symptom answers only: whether the parent got the web-grounded
     * reply or the fixed 811/911 line the lane falls back to. A present value is what
     * MARKS a row as a medical answer — the inbound row is deliberately left unstamped,
     * because a question Hale answered is not an unmet intent (migration 0090). */
    medicalReplySource: text('medical_reply_source').$type<MedicalReplySourceValue>(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** INBOUND only: when this text was actually handed to C1's queue. Null means the
     * job does not exist — either the enqueue has not happened yet or it failed. It is a
     * separate question from "does a row exist", and conflating the two is what let a
     * failed enqueue read as a handled message forever (the retry saw the row and said
     * 'duplicate'). The reconciler re-drives rows left null. */
    handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A present dedupe_key is unique — the idempotency guard the drain relies on.
    dedupeKeyUniq: uniqueIndex('channel_messages_dedupe_key_uniq')
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
    // Status callbacks resolve a row by the provider's id.
    providerIdx: index('channel_messages_provider_msg_idx').on(table.providerMessageId),
    // One inbound row per provider message, enforced by the DATABASE. The webhook's
    // duplicate guard used to be select-then-insert, which two concurrent deliveries of
    // the same MessageSid both pass — Twilio resends on a 15s timeout, so the resend can
    // land mid-flight. This index is what makes the insert itself the claim: exactly one
    // request wins it and is the one that enqueues. Partial on direction, because
    // outbound rows legitimately share nothing with this rule.
    inboundProviderUniq: uniqueIndex('channel_messages_inbound_provider_msg_uniq')
      .on(table.providerMessageId)
      .where(sql`${table.direction} = 'in' AND ${table.providerMessageId} IS NOT NULL`),
    // Cap counting: recent rows for a parent + category.
    capIdx: index('channel_messages_cap_idx').on(
      table.parentUserId,
      table.category,
      table.createdAt,
    ),
    // The founder digest's weekly window over deflections. Partial, so it indexes only
    // the handful of rows that carry a lane rather than the whole ledger.
    unmetIdx: index('channel_messages_unmet_idx')
      .on(table.createdAt)
      .where(sql`${table.unmetLane} IS NOT NULL`),
  }),
);

export type ChannelMessageRow = typeof channelMessages.$inferSelect;
export type NewChannelMessageRow = typeof channelMessages.$inferInsert;
