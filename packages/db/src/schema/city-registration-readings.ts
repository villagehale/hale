import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * VIL-684 · what Hale last read about one city's registration opening for one cycle.
 *
 * Looked up per family, wherever they live: the city comes from the family's own place
 * (the national postal tables), the official page from a live search, and the date
 * from that page through the VIL-423 reader. This row is the cache of that read, kept
 * per city so two families in one town cost one lookup, and it is the "last-known
 * state" a re-read is compared against. Never a hand-typed date.
 *
 * Family-AGNOSTIC, like registration_discovery_readings: a public place name, a cycle
 * label and what a public page said. No family_id, no postal code, no PII (rule #1).
 *
 * Append-only. The newest `verified` or `not_found` row by `read_at` for a (place_key,
 * cycle_label) is the reading; an older row is history. A `retry` row is a lookup that
 * wrote no reading: never the reading, only when the city is next looked up.
 */
export const CITY_REGISTRATION_READING_STATUSES = ['verified', 'not_found', 'retry'] as const;
export type CityRegistrationReadingStatus = (typeof CITY_REGISTRATION_READING_STATUSES)[number];

export const cityRegistrationReadings = pgTable(
  'city_registration_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The folded city, province or state, country and district, joined: the cache key. */
    placeKey: text('place_key').notNull(),
    /** The table's spelling of the city. */
    city: text('city').notNull(),
    provinceOrState: text('province_or_state'),
    country: text('country').notNull(),
    /** Toronto's registration district, where the family's area names one. */
    district: text('district'),
    cycleLabel: text('cycle_label').notNull(),
    status: text('status').$type<CityRegistrationReadingStatus>().notNull(),
    /** Why there is no date, by name: no official page, the page says later, unreadable. */
    reason: text('reason'),
    /** The municipality the search named as the one running recreation there. */
    municipality: text('municipality'),
    /** The official page the date was read off. Null only when nothing verified. */
    sourceUrl: text('source_url'),
    /** The verified reading (dates, zone, the page words each date stands on). */
    reading: jsonb('reading').$type<Record<string, unknown>>(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
    /** When this reading is stale and the page is read again. */
    reverifyAt: timestamp('reverify_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    placeCycleReadIdx: index('city_registration_readings_place_cycle_read_idx').on(
      table.placeKey,
      table.cycleLabel,
      table.readAt,
    ),
  }),
);

export type CityRegistrationReading = typeof cityRegistrationReadings.$inferSelect;
export type NewCityRegistrationReading = typeof cityRegistrationReadings.$inferInsert;
