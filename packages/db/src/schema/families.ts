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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
