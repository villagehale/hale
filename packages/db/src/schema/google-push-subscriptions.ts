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
import { integrations } from './integrations.js';

/**
 * One Google push subscription per connector connection (VIL-401).
 *
 * Calendar `events.watch` and Gmail `users.watch` both expire (Gmail's cap is 7 days).
 * The poll sweep is the fallback; this row is how a push is authenticated and how a
 * channel is renewed before it dies. It is NOT the sync cursor — `provider_metadata`
 * on the integration stays the historyId / syncToken, and a successful sync replaces
 * that blob, so channel id, resource id and expiration live here instead.
 *
 * The channel token itself is not stored. `token_hash` is SHA-256 of the secret we
 * handed Google, and the webhook compares in constant time. The Gmail address is not
 * stored either: `mailbox_key` is the email blind index, which is what a Pub/Sub push
 * is looked up by.
 *
 * Deleting the integration (and so the family) takes the row with it.
 */
export const googlePushSubscriptions = pgTable(
  'google_push_subscriptions',
  {
    integrationId: uuid('integration_id')
      .primaryKey()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** 'gcal' | 'gmail'. Drive has no push channel. */
    provider: text('provider').notNull(),
    /** Calendar watch channel id. Null on a Gmail row. */
    channelId: text('channel_id'),
    /** Calendar `resourceId`, required to stop the channel. Null on a Gmail row. */
    resourceId: text('resource_id'),
    /** SHA-256 hex of the Calendar channel token. Null on a Gmail row. */
    tokenHash: text('token_hash'),
    /** Email blind index of the Gmail mailbox. Null on a Calendar row. */
    mailboxKey: text('mailbox_key'),
    /** Pub/Sub topic this Gmail watch publishes to. Null on a Calendar row. */
    topicName: text('topic_name'),
    expiration: timestamp('expiration', { withTimezone: true }),
    /** Pushes for this connection before this instant are coalesced, not re-run. */
    debounceUntil: timestamp('debounce_until', { withTimezone: true }),
    /** A push arrived during the debounce window and still needs one trailing sync. */
    pending: boolean('pending').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerCheck: check(
      'google_push_subscriptions_provider_chk',
      sql`${table.provider} IN ('gcal', 'gmail')`,
    ),
    shapeCheck: check(
      'google_push_subscriptions_shape_chk',
      sql`(
        ${table.provider} = 'gcal'
        AND ${table.channelId} IS NOT NULL
        AND ${table.resourceId} IS NOT NULL
        AND ${table.tokenHash} IS NOT NULL
      ) OR (
        ${table.provider} = 'gmail'
        AND ${table.mailboxKey} IS NOT NULL
        AND ${table.topicName} IS NOT NULL
      )`,
    ),
    channelIdx: uniqueIndex('google_push_subscriptions_channel_id_idx')
      .on(table.channelId)
      .where(sql`${table.channelId} IS NOT NULL`),
    mailboxIdx: index('google_push_subscriptions_mailbox_idx').on(table.mailboxKey),
  }),
);

export type GooglePushSubscription = typeof googlePushSubscriptions.$inferSelect;
export type NewGooglePushSubscription = typeof googlePushSubscriptions.$inferInsert;
