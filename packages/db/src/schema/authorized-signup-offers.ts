import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/** One session on a provider form. Labels are public slot names, never a child. */
export interface AuthorizedSignupSession {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  full: boolean;
  priceCents: number | null;
  partySize?: number | null;
  seatingNote?: string | null;
}

/**
 * VIL-375 — the activity a parent may authorize Hale to register, and nothing else.
 *
 * One pending row per family. The browser runner reads child and parent details
 * from the family record at fill time and does not copy them here. Audit rows
 * point at this id and carry reason codes, never those details.
 */
export const authorizedSignupOffers = pgTable(
  'authorized_signup_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    childId: uuid('child_id')
      .notNull()
      .references(() => children.id, { onDelete: 'cascade' }),
    parentUserId: uuid('parent_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Opaque public activity id. Not a sentence and not a child name. */
    activityKey: text('activity_key').notNull(),
    registrationUrl: text('registration_url').notNull(),
    sessions: jsonb('sessions').$type<AuthorizedSignupSession[]>().notNull(),
    /** The only price the parent has approved, in cents. Null means none. */
    approvedPriceCents: integer('approved_price_cents'),
    /** pending, submitting, completed, or handed_back. */
    status: text('status').notNull().default('pending'),
    authorizedSessionId: text('authorized_session_id'),
    /** The inbound channel_messages id, never the body. */
    authorizingMessageId: text('authorizing_message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('authorized_signup_offers_family_idx').on(table.familyId, table.createdAt),
    onePending: uniqueIndex('authorized_signup_offers_one_pending')
      .on(table.familyId)
      .where(sql`${table.status} = 'pending'`),
  }),
);

export type AuthorizedSignupOffer = typeof authorizedSignupOffers.$inferSelect;
export type NewAuthorizedSignupOffer = typeof authorizedSignupOffers.$inferInsert;
