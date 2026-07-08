import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * A hand-verified, family-AGNOSTIC directory of public local resources (EarlyON
 * centres, public-library kids' programs, splash pads, public-health lines)
 * surfaced as a calm "Resources" rail on the Village surface.
 *
 * Unlike villageCandidates these rows are NOT tied to a family and are never
 * LLM-discovered — they are seeded from a verified list, so nothing here is
 * fabricated. Nothing is PII either (rule #1): a resource is a public program's
 * name, category, coarse service area, and outbound URL — there is no family_id
 * and no child reference.
 *
 * (name, area) is UNIQUE so the seed is idempotent — a re-run upserts the same row
 * rather than duplicating it. sortOrder lets the seed control the rail's order.
 */
export const curatedResources = pgTable(
  'curated_resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Human category for the rail's chip (e.g. "Public health"). Free text. */
    category: text('category').notNull(),
    /** Coarse service area (e.g. "Halton Region", "Toronto") — never a precise
     * point (rule #1); a resource serves a region, not a household. */
    area: text('area').notNull(),
    url: text('url').notNull(),
    description: text('description').notNull(),
    /** Controls the rail order without relying on insert order. */
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameAreaIdx: uniqueIndex('curated_resources_name_area_idx').on(table.name, table.area),
  }),
);

export type CuratedResource = typeof curatedResources.$inferSelect;
export type NewCuratedResource = typeof curatedResources.$inferInsert;
