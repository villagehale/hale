import { pgTable, uuid, text, date, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { childGenderEnum } from './enums.js';
import { families } from './families.js';

export const children = pgTable(
  'children',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Given / first name. Required since onboarding's first step. */
    name: text('name').notNull(),
    /** Family / last name, collected post-auth in setup. Nullable: optional,
     * and many single-name records predate it. */
    lastName: text('last_name'),
    dateOfBirth: date('date_of_birth').notNull(),
    /** Optional, sensitive (rule #1) gender. Non-null with an explicit
     * 'unspecified' default so a skipped answer is a value, not a SQL null. */
    gender: childGenderEnum('gender').notNull().default('unspecified'),
    biologicalSex: text('biological_sex'),
    /** Private-bucket storage key for an uploaded profile photo, or NULL for the
     * initials fallback. The most sensitive asset class Hale stores (rule #1): the
     * bytes live in the PRIVATE 'family-docs' bucket, never public — this holds only
     * the server-generated key (avatars/{familyId}/{childId}); the viewer reads it
     * through a short-TTL signed URL. One object per child, overwritten in place on
     * replace, so the key is stable and reclaimable by (family, child). */
    avatarPath: text('avatar_path'),
    /** When the photo was last set. The stable key is overwritten in place, so the
     * rendered signed URL carries ?v=<this epoch> as a deterministic cache-buster — a
     * replaced photo can't render stale. Null iff there is no photo. */
    avatarUpdatedAt: timestamp('avatar_updated_at', { withTimezone: true }),
    gestationalWeeks: integer('gestational_weeks'),
    birthWeightG: integer('birth_weight_g'),
    hospitalOfBirth: text('hospital_of_birth'),
    /** Family default parenting style is on the family; overrides per-child go here. */
    parentingStyleOverrides: jsonb('parenting_style_overrides')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Free-text interest tags driving village discovery (e.g. ["swimming", "music"]). */
    interests: jsonb('interests').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('children_family_idx').on(table.familyId),
  }),
);

export type Child = typeof children.$inferSelect;
export type NewChild = typeof children.$inferInsert;
