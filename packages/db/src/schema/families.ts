import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { onboardingStageEnum, planTierEnum } from './enums.js';

export const families = pgTable('families', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  countryCode: text('country_code').notNull().default('CA'),
  provinceOrState: text('province_or_state'),
  primaryLanguage: text('primary_language').notNull().default('en'),
  onboardingStage: onboardingStageEnum('onboarding_stage').notNull().default('pending_invite'),
  planTier: planTierEnum('plan_tier').notNull().default('free'),
  /** Structured location, collected post-auth (rule #1). Coarse by construction —
   * the finest grain stored is a postal code, which drives neighbourhood discovery
   * but is never surfaced precisely. All nullable: a family opts in to local
   * discovery by setting these. countryCode/provinceOrState above predate this and
   * stay; country/province here are the discovery-facing free-text values. */
  country: text('country'),
  province: text('province'),
  city: text('city'),
  postalCode: text('postal_code'),
  /** Coarse area for village discovery (FSA / neighborhood) — never a precise
   * address or child location (rule #1). Nullable: set only when a family opts
   * in to local discovery. Kept = postal_code for back-compat with existing
   * discovery reads. */
  areaCoarse: text('area_coarse'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
