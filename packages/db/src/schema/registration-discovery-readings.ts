import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One reading the weekly registration sweep took of a discovery target (VIL-360).
 *
 * The sweep used to email a count and then forget what the page said. Toronto's
 * Fall 2026 dates were public for four Mondays and the digest never named them,
 * and afterwards there was no row to tell "extraction saw the date and the email
 * was missed" from "the page we fetched never had it". This table is that row.
 *
 * Family-AGNOSTIC ops data, like registration_verify_runs: a municipal page, a
 * cycle label, and whether the reading cleared the corroboration bar. No
 * family_id, no PII (rule #1). A target stays on the hand-kept list until a
 * human seeds the window, so a `published` reading that is still here a week
 * later is the escalation — the gap did not close itself.
 *
 * Append-only. A second Monday inserts another row rather than overwriting the
 * first, which is what makes "7 days later" a comparison instead of a flag
 * someone forgot to clear.
 */
export const registrationDiscoveryReadings = pgTable(
  'registration_discovery_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    municipality: text('municipality').notNull(),
    programDomain: text('program_domain').notNull(),
    cycleLabel: text('cycle_label').notNull(),
    /** The URL this reading is of. A target watches more than one page. */
    sourceUrl: text('source_url').notNull(),
    /** True only when the reading cleared the same bar a suggestion must clear. */
    published: boolean('published').notNull(),
    /** The extracted window, or null when the page yielded nothing usable. */
    reading: jsonb('reading').$type<Record<string, unknown> | null>(),
    /**
     * sha256 of the page text this reading was taken from. Null when the fetch
     * itself failed — there was no page to hash, and that is a different fact
     * from a page that hashed and said nothing.
     */
    pageHash: text('page_hash'),
    /** The sweep's own clock, not the insert clock, so a replayed week is dated
     * as the week it claims to be. */
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    targetReadIdx: index('registration_discovery_readings_target_read_idx').on(
      table.municipality,
      table.programDomain,
      table.cycleLabel,
      table.readAt,
    ),
  }),
);

export type RegistrationDiscoveryReading = typeof registrationDiscoveryReadings.$inferSelect;
export type NewRegistrationDiscoveryReading = typeof registrationDiscoveryReadings.$inferInsert;
