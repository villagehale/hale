import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { families } from './families.js';

/**
 * A family's SAVED coarse areas for village discovery — the switcher behind the
 * Village header ("home", "grandma's"). One row per saved place; exactly one is
 * active per family (the partial unique index below), and village content derives
 * from the active row (discover.ts). Additive over the single stored area on
 * `families`; a family with no rows falls back to the legacy family location
 * fields (back-compat), and the 0051 backfill seeds one active row per family.
 *
 * Privacy (rule #1): COARSE by construction. The finest grain stored is a postal
 * code (the discovery layer only ever derives its coarse prefix — see
 * location-input.deriveAreaCoarse). There is deliberately NO latitude/longitude
 * column: the server never accepts or stores precise device coordinates — the
 * client resolves "use my current location" to a coarse {city, province} on-device
 * and saves only that.
 */
export const familyAreas = pgTable(
  'family_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    city: text('city').notNull(),
    /** Province / state — nullable, mirroring families.province (a city alone is
     * enough to save an area). */
    province: text('province'),
    /** Optional human label a parent gives the area ("home", "grandma's"). Not a
     * content field — just a switcher name. */
    note: text('note'),
    /** Coarse postal (FSA), nullable — the discovery layer derives only its prefix,
     * never surfacing it precisely (rule #1). */
    postalCode: text('postal_code'),
    /** Exactly one active row per family drives village content. Enforced by the
     * partial unique index below; setActiveArea flips it transactionally. */
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('family_areas_family_idx').on(table.familyId),
    // At most one ACTIVE area per family — makes "exactly one active" true by
    // construction (rule #6). Partial (is_active) so inactive rows are unconstrained.
    familyActiveIdx: uniqueIndex('family_areas_family_active_idx')
      .on(table.familyId)
      .where(sql`${table.isActive}`),
  }),
);

export type FamilyArea = typeof familyAreas.$inferSelect;
export type NewFamilyArea = typeof familyAreas.$inferInsert;
