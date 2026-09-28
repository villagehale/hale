import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { civicVenues } from './civic.js';
import { families } from './families.js';

/**
 * VIL-378 — hidden-social discovery for the kids' year planner.
 *
 * Family-agnostic public reference data, same class as civic_venues: a curated
 * list of professional accounts that post kid activities, plus the spots parsed
 * out of their public captions. A parent forward is the exception — that row
 * carries family_id so erasure takes it with the household (rule #1).
 *
 * Instagram Stories, Xiaohongshu, and WeChat are not polled. parent_forward and
 * xhs exist so a human-forwarded link has a place to land. tos_risk
 * 'violates_tos' exists so a scraper experiment cannot be stored unlabeled;
 * the seed does not use it.
 *
 * Region is a pg enum on purpose: the product promise is the five GTA regions
 * plus a day-trip fringe, and a sixth region is a decision, not a typo.
 */

export const GTA_REGIONS = ['toronto', 'peel', 'york', 'halton', 'durham', 'day_trip'] as const;
export type GtaRegion = (typeof GTA_REGIONS)[number];

export const gtaRegionEnum = pgEnum('gta_region', [
  'toronto',
  'peel',
  'york',
  'halton',
  'durham',
  'day_trip',
]);

export const SOCIAL_PLATFORMS = [
  'instagram',
  'facebook_page',
  'xhs',
  'web',
  'parent_forward',
] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_ACCOUNT_TYPES = ['business', 'creator', 'page', 'unknown'] as const;
export type SocialAccountType = (typeof SOCIAL_ACCOUNT_TYPES)[number];

/** Taxonomy T1–T14 from the hidden-social brief. Text, not an enum: a new
 * category is a data change (rule #9). */
export const SOCIAL_CATEGORIES = [
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'T7',
  'T8',
  'T9',
  'T10',
  'T11',
  'T12',
  'T13',
  'T14',
] as const;
export type SocialCategory = (typeof SOCIAL_CATEGORIES)[number];

export const SOCIAL_INGEST_METHODS = [
  'graph_business_discovery',
  'fb_ppca',
  'parent_forward',
  'manual',
  'scrape_experiment',
] as const;
export type SocialIngestMethod = (typeof SOCIAL_INGEST_METHODS)[number];

export const SOCIAL_TOS_RISKS = ['official', 'gray', 'violates_tos'] as const;
export type SocialTosRisk = (typeof SOCIAL_TOS_RISKS)[number];

export const SOCIAL_MEDIA_KINDS = ['feed', 'reel', 'story_forward', 'screenshot'] as const;
export type SocialMediaKind = (typeof SOCIAL_MEDIA_KINDS)[number];

export const SOCIAL_EXTRACTION_METHODS = ['llm', 'human', 'placeholder'] as const;
export type SocialExtractionMethod = (typeof SOCIAL_EXTRACTION_METHODS)[number];

export const SOCIAL_REVIEW_STATUSES = ['auto', 'needs_review', 'approved', 'rejected'] as const;
export type SocialReviewStatus = (typeof SOCIAL_REVIEW_STATUSES)[number];

/** Signup-open watch, same class as a municipal registration morning. Null
 * until a spot has registration_opens_at. */
export const SOCIAL_WATCH_STATUSES = ['scheduled', 'armed', 'fired', 'filled', 'missed'] as const;
export type SocialWatchStatus = (typeof SOCIAL_WATCH_STATUSES)[number];

export const watchedSources = pgTable(
  'watched_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<SocialPlatform>().notNull(),
    /** Handle without a leading @. Lowercased by the seed. */
    handle: text('handle').notNull(),
    displayName: text('display_name').notNull(),
    profileUrl: text('profile_url').notNull(),
    externalId: text('external_id'),
    accountType: text('account_type').$type<SocialAccountType>().notNull(),
    category: text('category').$type<SocialCategory>().notNull(),
    region: gtaRegionEnum('region').notNull(),
    geoCity: text('geo_city'),
    /** Venue FSA when a public page states one. Never a family's postal code. */
    geoFsa: text('geo_fsa'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    civicVenueId: uuid('civic_venue_id').references(() => civicVenues.id, { onDelete: 'set null' }),
    languages: text('languages').array().notNull().default(['en']),
    /** 1 = poll often (sell-out and weekly schedules). */
    priority: integer('priority').notNull().default(2),
    pollCadenceMinutes: integer('poll_cadence_minutes').notNull().default(720),
    ingestMethod: text('ingest_method').$type<SocialIngestMethod>().notNull(),
    tosRisk: text('tos_risk').$type<SocialTosRisk>().notNull(),
    active: boolean('active').notNull().default(false),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    /** Newest media id already seen. Null means the next poll only sets a baseline. */
    lastMediaId: text('last_media_id'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    platformCheck: check(
      'watched_sources_platform_chk',
      sql`${table.platform} IN ('instagram', 'facebook_page', 'xhs', 'web', 'parent_forward')`,
    ),
    accountCheck: check(
      'watched_sources_account_type_chk',
      sql`${table.accountType} IN ('business', 'creator', 'page', 'unknown')`,
    ),
    categoryCheck: check(
      'watched_sources_category_chk',
      sql`${table.category} IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14')`,
    ),
    ingestCheck: check(
      'watched_sources_ingest_method_chk',
      sql`${table.ingestMethod} IN ('graph_business_discovery', 'fb_ppca', 'parent_forward', 'manual', 'scrape_experiment')`,
    ),
    tosCheck: check(
      'watched_sources_tos_risk_chk',
      sql`${table.tosRisk} IN ('official', 'gray', 'violates_tos')`,
    ),
    platformHandleUniq: uniqueIndex('watched_sources_platform_handle_uniq').on(
      table.platform,
      table.handle,
    ),
    regionIdx: index('watched_sources_region_idx').on(table.region),
    categoryIdx: index('watched_sources_category_idx').on(table.category),
    dueIdx: index('watched_sources_due_idx').on(table.lastPolledAt).where(sql`${table.active}`),
  }),
);

export const socialSpots = pgTable(
  'social_spots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => watchedSources.id, { onDelete: 'cascade' }),
    /** Set only when a parent forwarded the post. Public polls stay null so a
     * household deletion does not take the shared spot with it. */
    familyId: uuid('family_id').references(() => families.id, { onDelete: 'cascade' }),
    platformMediaId: text('platform_media_id').notNull(),
    permalink: text('permalink').notNull(),
    rawCaption: text('raw_caption'),
    mediaKind: text('media_kind').$type<SocialMediaKind>().notNull(),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    timezone: text('timezone').notNull().default('America/Toronto'),
    /** Completed years, the unit captions use. Null means the caption stated no age. */
    ageMin: integer('age_min'),
    ageMax: integer('age_max'),
    priceCents: integer('price_cents'),
    capacity: integer('capacity'),
    registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }),
    registrationUrl: text('registration_url'),
    venueName: text('venue_name'),
    venueAddress: text('venue_address'),
    category: text('category').$type<SocialCategory>().notNull(),
    region: gtaRegionEnum('region').notNull(),
    geoFsa: text('geo_fsa'),
    extractionConfidence: doublePrecision('extraction_confidence').notNull(),
    extractionMethod: text('extraction_method').$type<SocialExtractionMethod>().notNull(),
    reviewStatus: text('review_status').$type<SocialReviewStatus>().notNull(),
    watchStatus: text('watch_status').$type<SocialWatchStatus>(),
    /** When the signup-open watch should next run. Null once the watch has ended. */
    nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    mediaKindCheck: check(
      'social_spots_media_kind_chk',
      sql`${table.mediaKind} IN ('feed', 'reel', 'story_forward', 'screenshot')`,
    ),
    categoryCheck: check(
      'social_spots_category_chk',
      sql`${table.category} IN ('T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11', 'T12', 'T13', 'T14')`,
    ),
    extractionCheck: check(
      'social_spots_extraction_method_chk',
      sql`${table.extractionMethod} IN ('llm', 'human', 'placeholder')`,
    ),
    reviewCheck: check(
      'social_spots_review_status_chk',
      sql`${table.reviewStatus} IN ('auto', 'needs_review', 'approved', 'rejected')`,
    ),
    watchCheck: check(
      'social_spots_watch_status_chk',
      sql`${table.watchStatus} IS NULL OR ${table.watchStatus} IN ('scheduled', 'armed', 'fired', 'filled', 'missed')`,
    ),
    confidenceCheck: check(
      'social_spots_confidence_chk',
      sql`${table.extractionConfidence} >= 0 AND ${table.extractionConfidence} <= 1`,
    ),
    ageCheck: check(
      'social_spots_age_chk',
      sql`${table.ageMin} IS NULL OR ${table.ageMax} IS NULL OR ${table.ageMin} <= ${table.ageMax}`,
    ),
    sourceMediaUniq: uniqueIndex('social_spots_source_media_uniq').on(
      table.sourceId,
      table.platformMediaId,
    ),
    startsAtIdx: index('social_spots_starts_at_idx').on(table.startsAt),
    registrationIdx: index('social_spots_registration_opens_idx')
      .on(table.registrationOpensAt)
      .where(sql`${table.registrationOpensAt} IS NOT NULL`),
    wakeIdx: index('social_spots_wake_idx')
      .on(table.nextWakeAt)
      .where(sql`${table.watchStatus} IN ('scheduled', 'armed')`),
    familyIdx: index('social_spots_family_idx').on(table.familyId),
  }),
);

export type WatchedSource = typeof watchedSources.$inferSelect;
export type NewWatchedSource = typeof watchedSources.$inferInsert;
export type SocialSpot = typeof socialSpots.$inferSelect;
export type NewSocialSpot = typeof socialSpots.$inferInsert;
