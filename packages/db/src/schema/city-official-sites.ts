import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * VIL-684 · each municipality's own official website, as a structured public source
 * names it (Wikidata's "official website", P856). A registration page is read for a city
 * only when its host is this site's host or under it, so a news, aggregator, councillor
 * or mayor page can never supply a city's date. No hand-kept list of cities or domains.
 *
 * Family-AGNOSTIC public reference data: a place name and what a public source says
 * about it. No family_id, no PII (rule #1). Append-only; the newest row by `checked_at`
 * for a `municipality_key` is the answer.
 */
export const CITY_OFFICIAL_SITE_STATUSES = ['found', 'not_found'] as const;
export type CityOfficialSiteStatus = (typeof CITY_OFFICIAL_SITE_STATUSES)[number];

export const cityOfficialSites = pgTable(
  'city_official_sites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The folded city, province or state and country, joined. No district. */
    municipalityKey: text('municipality_key').notNull(),
    city: text('city').notNull(),
    provinceOrState: text('province_or_state'),
    country: text('country').notNull(),
    status: text('status').$type<CityOfficialSiteStatus>().notNull(),
    /** Why no site was established, by name: no entry, more than one, no website. */
    reason: text('reason'),
    /** The site's host, lower-cased, without a leading `www.`. Null when not found. */
    host: text('host'),
    /** The website exactly as the source states it. */
    website: text('website'),
    /** Where the website came from, e.g. `wikidata:Q172`. */
    source: text('source'),
    /** The source's statement of the website carries a reference. Null when not found. */
    referenced: boolean('referenced'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
    recheckAt: timestamp('recheck_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    keyCheckedIdx: index('city_official_sites_key_checked_idx').on(
      table.municipalityKey,
      table.checkedAt,
    ),
  }),
);

export type CityOfficialSite = typeof cityOfficialSites.$inferSelect;
export type NewCityOfficialSite = typeof cityOfficialSites.$inferInsert;
