import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';
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
  /** What the parent hopes Hale can help with — the optional onboarding intents
   * (see OnboardingIntent in @hale/types). Nullable: a family that picks none is
   * stored as null. Nothing else keys off this yet; it is captured for tailoring. */
  intents: text('intents').array(),
  /** When set, the family is scheduled for erasure (PIPEDA/Law 25) and the worker
   * hard-deletes it once now() passes this. NULL = not scheduled; clearing it
   * before the worker fires cancels the deletion (reversible by grace). */
  scheduledDeletionAt: timestamp('scheduled_deletion_at', { withTimezone: true }),
  /** Permanent founding ordinal (first 100 families), assigned once right after
   * provisioning and never recomputed — so later deletions can't shift anyone's
   * number. NULL = not a founding family (or the freak concurrent-signup race,
   * which forfeits the badge rather than failing onboarding). */
  foundingNumber: integer('founding_number'),
  /** The tokenized, revocable URL secret for this family's READ-ONLY ICS calendar
   * subscription feed (VIL-219). Every public ICS read resolves WHERE
   * ics_share_token = :token, so nulling it revokes the feed (same share-token
   * pattern as villageCandidates). Null = no feed minted yet. */
  icsShareToken: text('ics_share_token').unique(),
  /** The tokenized, revocable secret in the family's FORWARDING address
   * `hale+<token>@<inbound domain>` (VIL-352). Deliberately a SECOND secret beside
   * ics_share_token rather than a reuse of it: revoking a forwarding address must not
   * also kill every calendar link the family holds, and revoking the calendar feed must
   * not silently stop their mail being read. Lowercase hex, because the inbound parser
   * lowercases every address it sees. Null = no address minted yet. */
  inboundForwardToken: text('inbound_forward_token'),
  /** Linq group chat for this household's two caregivers (VIL-335). Null until
   * Hale opens one, or a group webhook from an enrolled parent is accepted.
   * The reply still uses the inbound chat id; this column is the durable home
   * so a later co-parent add does not open a second group. */
  linqGroupChatId: text('linq_group_chat_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  // A unique INDEX, matching the migration: past the re-runnable watermark a bare
  // ADD CONSTRAINT (what Drizzle's `.unique()` emits) raises on the second apply.
  inboundForwardTokenUniq: uniqueIndex('families_inbound_forward_token_uniq').on(
    table.inboundForwardToken,
  ),
  linqGroupChatUniq: uniqueIndex('families_linq_group_chat_id_uniq')
    .on(table.linqGroupChatId)
    .where(sql`${table.linqGroupChatId} IS NOT NULL`),
}));

export type Family = typeof families.$inferSelect;
export type NewFamily = typeof families.$inferInsert;
