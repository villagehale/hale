import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { channelMessages } from './channel-messages.js';
import { families } from './families.js';

/**
 * The three closed vocabularies behind this table's `text` columns, held against
 * migration 0121's CHECK constraints by
 * packages/db/scripts/activity-reviews-vocabulary-consistency.test.mjs — the only gate
 * that reads the .sql against this file.
 */

/**
 * The kinds of thing a verdict can be ABOUT. Both members are venue-grain and global, so
 * two families offered the same place carry the same string and two different places
 * never collide — which is the whole precondition for pooling anything across families.
 *
 * A URL is deliberately not a member. `village_candidates.source_url` is one dataset page
 * for every EarlyON centre in Toronto and one page per library OCCURRENCE, so it is
 * either a collision that leaks one family's opinion onto an unrelated venue, or a key
 * three families can never share.
 */
export const REVIEW_SUBJECT_SOURCES = ['place', 'civic_venue'] as const;
export type ReviewSubjectSource = (typeof REVIEW_SUBJECT_SOURCES)[number];

/**
 * What a parent's reply can amount to. `did_not_attend` is stored and is NOT counted as
 * an opinion: a family that did not go has none, and counting them would inflate k toward
 * the threshold with silence. It is kept because "did they actually go" is the honest
 * denominator and the only attendance signal this product has.
 */
export const ACTIVITY_VERDICTS = ['worth_it', 'not_worth_it', 'did_not_attend'] as const;
export type ActivityVerdict = (typeof ACTIVITY_VERDICTS)[number];

/**
 * The only texture that travels between households: eight tags, paired, never about a
 * person, and with NO SAFETY MEMBER — a parent raising a safety concern is not writing a
 * review, and those words are claimed by the off-domain screen on the coach turn long
 * before this pass sees the row.
 */
export const ACTIVITY_REVIEW_TAGS = [
  'well_run',
  'disorganised',
  'too_crowded',
  'easy_parking',
  'hard_parking',
  'good_age_fit',
  'wrong_age_fit',
  'pricey',
] as const;
export type ActivityReviewTag = (typeof ACTIVITY_REVIEW_TAGS)[number];

/** At most three, so a reply cannot become a paragraph by another route. */
export const MAX_ACTIVITY_REVIEW_TAGS = 3;

/**
 * The four stages a reviewed placement's child can be in. Four of the five FAMILY_STAGES:
 * 'teenager' is absent from the CHECK, which makes a 13+ child's activity unreviewable by
 * anybody, including a future backfill (rule #1).
 */
export const ACTIVITY_REVIEW_AGE_BANDS = ['newborn', 'toddler', 'preschool', 'child'] as const;
export type ActivityReviewAgeBand = (typeof ACTIVITY_REVIEW_AGE_BANDS)[number];

/**
 * ONE HOUSEHOLD'S POSITION ON ONE PUBLIC VENUE.
 *
 * The parent's own sentence is not here and is stored nowhere — see 0121's header for
 * what is absent and why. The family_id cascade IS the erasure path.
 */
export const activityReviews = pgTable(
  'activity_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The inbound row that carried the words — erasing the message erases the verdict. */
    sourceMessageId: uuid('source_message_id')
      .notNull()
      .references(() => channelMessages.id, { onDelete: 'cascade' }),
    subjectSource: text('subject_source').notNull().$type<ReviewSubjectSource>(),
    /** An OPAQUE COMPARED STRING — a Google place id or a `civic_venues` id. Never parsed,
     * and deliberately not an FK: `village_candidates` is per-family and superseded by
     * the next discovery run, so a reference would make k>=3 unreachable. */
    subjectRef: text('subject_ref').notNull(),
    /** `matchAreaKey`'s coarse area, stamped at write time (rule #1 — an FSA's grain). */
    areaKey: text('area_key').notNull(),
    childAgeBand: text('child_age_band').$type<ActivityReviewAgeBand>(),
    verdict: text('verdict').notNull().$type<ActivityVerdict>(),
    tags: text('tags').array().notNull().default([]).$type<ActivityReviewTag[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** The k>=3 guarantee: with this, count(*) IS count(distinct family_id). */
    familySubjectUniq: uniqueIndex('activity_reviews_family_subject_uniq').on(
      table.familyId,
      table.subjectSource,
      table.subjectRef,
    ),
    subjectIdx: index('activity_reviews_subject_idx').on(
      table.subjectSource,
      table.subjectRef,
      table.areaKey,
    ),
    subjectSourceCheck: check(
      'activity_reviews_subject_source_check',
      sql`${table.subjectSource} IN ('place','civic_venue')`,
    ),
    verdictCheck: check(
      'activity_reviews_verdict_check',
      sql`${table.verdict} IN ('worth_it','not_worth_it','did_not_attend')`,
    ),
    ageBandCheck: check(
      'activity_reviews_age_band_check',
      sql`${table.childAgeBand} IS NULL OR ${table.childAgeBand} IN ('newborn','toddler','preschool','child')`,
    ),
    tagsCheck: check(
      'activity_reviews_tags_check',
      sql`${table.tags} <@ ARRAY['well_run','disorganised','too_crowded','easy_parking','hard_parking','good_age_fit','wrong_age_fit','pricey']::text[] AND coalesce(array_length(${table.tags},1),0) <= 3`,
    ),
  }),
);

export type ActivityReview = typeof activityReviews.$inferSelect;
export type NewActivityReview = typeof activityReviews.$inferInsert;
