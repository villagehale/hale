import { pgTable, uuid, text, date, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { families } from './families.js';

export const children = pgTable(
  'children',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    dateOfBirth: date('date_of_birth').notNull(),
    biologicalSex: text('biological_sex'),
    gestationalWeeks: integer('gestational_weeks'),
    birthWeightG: integer('birth_weight_g'),
    hospitalOfBirth: text('hospital_of_birth'),
    /** Family default parenting style is on the family; overrides per-child go here. */
    parentingStyleOverrides: jsonb('parenting_style_overrides')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('children_family_idx').on(table.familyId),
  }),
);

export type Child = typeof children.$inferSelect;
export type NewChild = typeof children.$inferInsert;
