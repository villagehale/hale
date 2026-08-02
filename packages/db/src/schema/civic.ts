import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * VIL-252 · M16 — the free civic programming layer: the EarlyON drop-ins and
 * library storytimes happening near a family this week that nobody told them about.
 *
 * Family-AGNOSTIC public reference data, like registration_windows and
 * curated_resources: there is no family_id and nothing here is PII (rule #1). A
 * library branch's street address and coordinates are the BRANCH's, published by
 * the library itself — the same class of public venue location village_candidates
 * already stores. No family's location is ever written here; the per-family
 * matching happens at read time against the family's coarse area.
 *
 * WHY A SEPARATE TABLE FROM village_candidates. A Thursday 10am storytime at
 * Armour Heights is one fact about the world, not one fact per family. Writing it
 * per-family would duplicate ~6,000 Toronto library events across every household
 * and make "is this still true?" a question with N answers. The facts live here
 * once; `projectCivicCandidates` selects the handful a given family should see and
 * writes those as village_candidates (run_type 'civic').
 *
 * OUT OF SCOPE, DELIBERATELY: Instagram and Facebook are never read. Centre and
 * branch socials are echoes of the calendars ingested here, they are ephemeral and
 * auth-walled, and scraping them violates both platforms' terms. The only way that
 * changes is a venue choosing to share its schedule with us directly.
 */

/** Which upstream system a venue and its sessions came from. A plain `text`
 * column with a TS union rather than a pg enum: coverage grows system by system
 * as each one's calendar is verified, and a new library system must not need a
 * migration (rule #9 — an enum ADD VALUE is a migration). */
export type CivicSystem = 'tpl' | 'markham' | 'rhpl' | 'earlyon_toronto';

/** What sort of place this is. Drives the village `kind` the projection writes. */
export type CivicVenueKind = 'library_branch' | 'earlyon_centre';

/**
 * How a session's time is expressed — and the two shapes are genuinely different
 * facts, not a style choice:
 *
 *   'occurrence' — a library event at a stated instant ("Aug 28, 10:30–11:30").
 *                  starts_at/ends_at carry it; it expires once past.
 *   'weekly'     — a standing drop-in slot ("Wednesdays 9:00–11:30"), which is
 *                  what an EarlyON centre publishes. day_of_week + start/end
 *                  minute carry it; the projection expands it to real dates.
 *
 * A CHECK constraint enforces that exactly one shape is populated, so a row that
 * claims to be weekly while carrying an instant cannot be stored at all.
 */
export type CivicRecurrence = 'occurrence' | 'weekly';

/** How the row's times were derived. 'structured' means the upstream system
 * published machine-readable start/end fields and no model was involved;
 * 'llm' means free text was parsed and the row carries a real chance of being
 * wrong, which is why confidence gating exists. */
export type CivicExtraction = 'structured' | 'llm';

/**
 * One real place that runs free programming — a library branch or an EarlyON
 * centre. `external_id` is the id the upstream system uses (a BiblioCommons
 * branch code like 'AH', a Toronto Open Data `loc_id`), so a re-sweep updates
 * the row it already wrote instead of duplicating it.
 */
export const civicVenues = pgTable(
  'civic_venues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    system: text('system').notNull().$type<CivicSystem>(),
    /** The upstream system's own id for this venue. Half of the natural key. */
    externalId: text('external_id').notNull(),
    kind: text('kind').notNull().$type<CivicVenueKind>(),
    name: text('name').notNull(),
    address: text('address'),
    city: text('city'),
    /** The VENUE's postal code (public, published by the venue). Never a family's
     * — a family's postal is coarsened to an FSA before it is ever stored. */
    postalCode: text('postal_code'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    /** The venue's own public page, for the "where did this come from" link. */
    url: text('url'),
    /** The feed this row was read from. NOT NULL so a venue can never be a guess. */
    sourceUrl: text('source_url').notNull(),
    /** When the weekly sweep last saw this venue in its upstream feed. A venue
     * that stops appearing keeps its row (its sessions expire on their own) but
     * its stale timestamp is the signal that coverage needs re-checking. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    systemExternalUniq: uniqueIndex('civic_venues_system_external_uniq').on(
      table.system,
      table.externalId,
    ),
    cityIdx: index('civic_venues_city_idx').on(table.city),
  }),
);

/**
 * One free session at a civic venue. Every row states where it came from
 * (`source_url`) and when we last confirmed it (`parsed_at`, `last_seen_at`), so
 * "is this still true?" is answerable without re-reading the source.
 *
 * THE TIME IS THE PRODUCT. A parent who shows up on the wrong morning with a
 * toddler is worse off than a parent we never told. That is why:
 *   - the time shape is CHECK-constrained (see CivicRecurrence),
 *   - LLM-parsed rows carry `confidence` and are gated before they ever surface,
 *   - a session the sweep stops seeing is superseded rather than silently kept.
 */
export const civicSessions = pgTable(
  'civic_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => civicVenues.id, { onDelete: 'cascade' }),
    /** The upstream id for this session. For a weekly EarlyON slot, a key derived
     * from the centre + day + times, so re-parsing the same published hours lands
     * on the same row instead of creating a second one. */
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    recurrence: text('recurrence').notNull().$type<CivicRecurrence>(),
    /** 'occurrence' shape: the actual instant. Null on weekly rows. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** 'weekly' shape: 0=Sunday..6=Saturday plus local minutes from midnight.
     * Minutes, not a time column, because the fact is a wall-clock slot in the
     * venue's own zone — not an instant that a DST change would shift. */
    dayOfWeek: integer('day_of_week'),
    startMinute: integer('start_minute'),
    endMinute: integer('end_minute'),
    /** Age band in MONTHS, matching @hale/types' stage boundaries. Null means the
     * source stated no age — which is surfaced as "all ages", never guessed. */
    ageMinMonths: integer('age_min_months'),
    ageMaxMonths: integer('age_max_months'),
    /** Whether the session costs nothing. Declared by the venue registry, never
     * inferred: library and EarlyON programming is free by policy, and neither
     * upstream feed publishes a price field at all. A source that ever does
     * publish one sets this from the source. */
    isFree: boolean('is_free').notNull().default(true),
    registrationRequired: boolean('registration_required').notNull().default(false),
    /** Upstream said this specific session is cancelled. Kept as a row (not
     * deleted) so a cancellation is a fact we can act on rather than an absence. */
    isCancelled: boolean('is_cancelled').notNull().default(false),
    extraction: text('extraction').notNull().$type<CivicExtraction>(),
    /** 0–1. Structured rows are 1. LLM rows carry the parse's own confidence,
     * already reduced by the deterministic corroboration check. */
    confidence: doublePrecision('confidence').notNull(),
    sourceUrl: text('source_url').notNull(),
    /** When the times in this row were derived from the source text. */
    parsedAt: timestamp('parsed_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the sweep last saw this session upstream. Drives stale detection. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft-retire: the sweep stopped seeing it, or it went stale. Reads filter
     * on IS NULL. Never hard-deleted, so a disappearance stays auditable. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    venueExternalUniq: uniqueIndex('civic_sessions_venue_external_uniq').on(
      table.venueId,
      table.externalId,
    ),
    venueIdx: index('civic_sessions_venue_idx').on(table.venueId),
    startsAtIdx: index('civic_sessions_starts_at_idx').on(table.startsAt),
  }),
);
