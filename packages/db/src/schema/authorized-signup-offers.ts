import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
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
 * VIL-558 · where a plan's Browser Use run stands when a sweep ends before the run does.
 * Browser Use ids, the cart total and the choice rank only; never a person or a link.
 * `paying` is written before the payment run is created, so a resume that finds it with
 * no run id never creates a second one.
 */
export type AuthorizedSignupPlanResume =
  | { phase: 'signup'; runId: string | null; sessionId: string | null; browserId: string | null }
  | {
      phase: 'paying';
      runId: string | null;
      sessionId: string;
      browserId: string | null;
      choiceIndex: number;
      cartTotalCents: number;
      holdExpiresAt: string | null;
      costUsd: string | null;
    };

/**
 * VIL-375 — the activity a parent may authorize Hale to register, and nothing else.
 *
 * One pending row per family and provider host. The browser runner reads child and parent details
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
    /**
     * The program's public name as the page or the parent gave it ("Little Kickers").
     * Lets a later message about another activity read as about another one. Never a child.
     */
    activityLabel: text('activity_label'),
    registrationUrl: text('registration_url').notNull(),
    sessions: jsonb('sessions').$type<AuthorizedSignupSession[]>().notNull(),
    /** The only price the parent has approved, in cents. Null means none. */
    approvedPriceCents: integer('approved_price_cents'),
    /** pending, planned, submitting, completed, or handed_back. */
    status: text('status').notNull().default('pending'),
    authorizedSessionId: text('authorized_session_id'),
    /** The inbound channel_messages id, never the body. */
    authorizingMessageId: text('authorizing_message_id'),
    /** Browser Use session cost in USD (model, search, browser, proxy), once its browser stopped. */
    browserUseCostUsd: numeric('browser_use_cost_usd', { precision: 12, scale: 6 }),
    /**
     * VIL-558 · the day-before plan (status `planned`). Session ids from `sessions`,
     * best first; the first one open at the open time is the one Hale registers.
     */
    planChoiceIds: text('plan_choice_ids').array(),
    /** The most the parent approved for this registration, in cents. */
    planMaxPriceCents: integer('plan_max_price_cents'),
    /** When registration opens. Hale joins the open from just before it. */
    planOpensAt: timestamp('plan_opens_at', { withTimezone: true }),
    /** True only when the parent said Hale may tick the provider's activity waiver. */
    planWaiverAccepted: boolean('plan_waiver_accepted'),
    planApprovedAt: timestamp('plan_approved_at', { withTimezone: true }),
    /** Set from the claim on: the plan's run resumes from here on a later sweep. */
    planResume: jsonb('plan_resume').$type<AuthorizedSignupPlanResume>(),
    /** A sweep is carrying the plan until then. Null once it checkpointed and let go. */
    planLeaseUntil: timestamp('plan_lease_until', { withTimezone: true }),
    /** The parent took the plan back while its run was going: no payment starts after it. */
    planCancelRequestedAt: timestamp('plan_cancel_requested_at', { withTimezone: true }),
    /**
     * Provider host of `registration_url`, normalized. Login, credentials,
     * seats, fees, register-now and waitlist all key on this, not a platform name.
     */
    providerHost: text('provider_host').notNull(),
    /** True when the program is already open: skip the timed-open countdown. */
    planAlreadyOpen: boolean('plan_already_open'),
    /** Live seat/fee read. Never a person. */
    planAvailability: jsonb('plan_availability').$type<Record<string, unknown>>(),
    planAvailabilityAt: timestamp('plan_availability_at', { withTimezone: true }),
    /**
     * When Hale last sent this parent a text about the ask after the offer itself: a
     * question back, a mismatch question, a login ask, a receipt. Null: the offer was the
     * last. A bare yes or no answers the ask asked last, by `coalesce(this, created_at)`.
     */
    lastAskedAt: timestamp('last_asked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('authorized_signup_offers_family_idx').on(table.familyId, table.createdAt),
    /** One pending offer per family and provider host (several plans, no collision). */
    onePending: uniqueIndex('authorized_signup_offers_one_pending_per_host')
      .on(table.familyId, table.providerHost)
      .where(sql`${table.status} = 'pending'`),
    /** One registration per family at a time, held under concurrent sweeps (VIL-558). */
    oneSubmitting: uniqueIndex('authorized_signup_offers_one_submitting')
      .on(table.familyId)
      .where(sql`${table.status} = 'submitting'`),
    plannedIdx: index('authorized_signup_offers_planned_idx')
      .on(table.planOpensAt)
      .where(sql`${table.status} = 'planned'`),
  }),
);

export type AuthorizedSignupOffer = typeof authorizedSignupOffers.$inferSelect;
export type NewAuthorizedSignupOffer = typeof authorizedSignupOffers.$inferInsert;
