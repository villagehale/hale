import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';
import { users } from './users.js';

export type BillingNoticeLane = 'payment' | 'plan_change';
export type BillingNoticeStatus = 'open' | 'sending' | 'unconfirmed' | 'sent' | 'dropped';

/** What Stripe said, with no name, email, card or message text. */
export interface BillingNoticeEventFacts {
  /** Finds this notice's `family_plan_updated` audit rows. */
  eventIds: string[];
  /** Payment lane: binds the payer and the thread proof to this session. */
  sessionCreatedAt?: string;
  sessionTier?: 'plus' | 'family';
  subscriptionId?: string;
  /** Two different subscriptions merged into one payment row: never a plain receipt. */
  conflictingPayment?: boolean;
  /** Plan-change lane. `why` is null for anything but a cancel or a failed payment. */
  ended?: { subscriptionId: string; why: 'cancelled' | 'payment_failed' | null };
  /** Further subscriptions that ended into this row. Each is a subject the payer must own. */
  alsoEnded?: string[];
  refunds?: {
    chargeId: string;
    refundedMinor: number;
    chargeMinor: number;
    currency: string;
    full: boolean;
    /** Set by the drain. Null: this charge has no subscription. */
    subscriptionId?: string | null;
  }[];
}

/**
 * VIL-735 · one owed text about a payment, a cancel or a refund. The webhook records the
 * row; the drain reads the facts, has the model write the text and sends it through the
 * dispatch. `open` takes merges and is due at `next_try_at`; `sending` is one attempt in
 * flight and its `next_try_at` is the lease; `unconfirmed` is a try that may have reached
 * the parent, due again at `next_try_at` under the same provider key, and it takes no
 * merges because Linq could drop the merged text as a repeat; `sent` and `dropped` are final.
 */
export const billingNotices = pgTable(
  'billing_notices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id').references(() => users.id, { onDelete: 'set null' }),
    lane: text('lane').$type<BillingNoticeLane>().notNull(),
    status: text('status').$type<BillingNoticeStatus>().notNull().default('open'),
    dropReason: text('drop_reason'),
    facts: jsonb('facts').$type<BillingNoticeEventFacts>().notNull(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull(),
    nextTryAt: timestamp('next_try_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    channelMessageId: uuid('channel_message_id').references(() => channelMessages.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneOpen: uniqueIndex('billing_notices_one_open_uniq')
      .on(table.familyId, table.lane)
      .where(sql`${table.status} = 'open'`),
    due: index('billing_notices_due_idx')
      .on(table.nextTryAt)
      .where(sql`${table.status} IN ('open', 'sending', 'unconfirmed')`),
    recipient: index('billing_notices_recipient_idx').on(table.parentUserId),
    laneCheck: check(
      'billing_notices_lane_check',
      sql`${table.lane} IN ('payment', 'plan_change')`,
    ),
    statusCheck: check(
      'billing_notices_status_check',
      sql`${table.status} IN ('open', 'sending', 'unconfirmed', 'sent', 'dropped')`,
    ),
  }),
);

export type BillingNotice = typeof billingNotices.$inferSelect;
export type NewBillingNotice = typeof billingNotices.$inferInsert;
