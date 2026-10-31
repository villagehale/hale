import { type Database, type Municipality, schema } from '@hale/db';
import { type FamilyStage, ageInMonths, deriveStage } from '@hale/types';
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { CONFIDENCE_FLOOR } from '~/lib/memory/facts';
import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';

/**
 * THE THREE FACTS THE ACTIVITY LANE READS FROM THE DATABASE — and the whole reason it
 * reads them rather than accepting them from the model.
 *
 * The town and the age band travel with a query to Anthropic's US `web_search`: a
 * cross-border disclosure, so rule #1 governs what they may be. A model asked for "the
 * location" will happily write a street; a model asked for "the age" writes the age. Both
 * are exactly what must not cross. Resolving them HERE, from `families.area_coarse` and a
 * date of birth, is what makes "town-level and age-band only" a property of the code
 * rather than a line in a prompt.
 *
 * The names are the third, and they are read for the opposite purpose: nothing is sent
 * with them, they are what a query is REFUSED for containing (deidentify.ts).
 */
export interface ActivityFamilyReader {
  municipality(database: Database, familyId: string): Promise<Municipality | null>;
  stage(database: Database, familyId: string, childId: string | null): Promise<FamilyStage | null>;
  householdNames(database: Database, familyId: string): Promise<string[]>;
  familyFit?(database: Database, familyId: string, now?: Date): Promise<FamilyFit>;
}

/**
 * VIL-518. THE SMALL SLICE OF THE FAMILY A FIND IS RANKED AND OPENED ON — handed back to
 * the model beside the picks, never sent to the search (only town + age band cross).
 *
 * Facts, not copy: who the kids are (age, stage; a teen is a stage and nothing else), the
 * home town, and the durable preferences that change which pick wins. The model uses it
 * to rank and to say who a pick is for; it is not a list to recite. Every field may be
 * empty, and empty means unknown — the find still runs and nothing is invented to fill it.
 */
export interface FamilyFitChild {
  childId: string;
  /** Null for a teen (rule #1/#5 — no teen name leaves the household). */
  name: string | null;
  stage: FamilyStage;
  /** Whole years; null for a teen. */
  ageYears: number | null;
}

export interface FamilyFitPreference {
  /** The child it is about, or null for the whole family. */
  childId: string | null;
  key: string;
  value: unknown;
  /** VIL-519. Where Hale learned it: the parent said it, a calendar or receipt showed
   * it, or Hale inferred it. `legacy` is a row from before sources were kept. */
  source: FactSource;
  /** VIL-519. The day (UTC, YYYY-MM-DD) the source was seen — how fresh it is. */
  seenOn: string;
}

export type FactSource = 'parent_message' | 'calendar' | 'receipt' | 'inferred' | 'legacy';

/** VIL-519. A fact too old to trust for a pick. It does NOT steer the ranking; it is
 * named (key only, never the old value) so the model may check it in its own words when
 * it matters to this find, or let it be. */
export interface FamilyFitRecheck {
  childId: string | null;
  key: string;
  seenOn: string;
}

export interface FamilyFit {
  children: FamilyFitChild[];
  /** The home municipality the search looked around, or null when unknown. */
  homeArea: Municipality | null;
  preferences: FamilyFitPreference[];
  /** VIL-519. Stale facts held back from ranking. Empty when nothing is stale. */
  recheck: FamilyFitRecheck[];
}

/** Durable facts that steer a pick: tastes (indoor, not scary, swim) and logistics
 * (stroller, language, how far they will drive). Medical/relationship/voice never ride. */
const FIT_FACT_TYPES = ['preference', 'logistic'] as const;
/** Small on purpose: a slice, not the memory. */
export const FAMILY_FIT_PREFERENCE_LIMIT = 8;
/** One stale key at most (Design lock, one-ask): a hint, not a questionnaire. */
export const FAMILY_FIT_RECHECK_LIMIT = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * VIL-519. How long a fact from each source is trusted to steer a pick. A guess goes
 * stale fastest; what a parent told us or a receipt showed lasts a school year. Past
 * this a fact is held back from ranking and offered as a recheck instead — never
 * silently used.
 */
export const FACT_FRESH_DAYS: Readonly<Record<FactSource, number>> = {
  inferred: 90,
  calendar: 180,
  receipt: 365,
  parent_message: 365,
  legacy: 365,
};

/**
 * VIL-519. Keys that shadow the record's own age or home area. The children's dates of
 * birth and `families.area_coarse` are the corrected truth (a parent's edit lands
 * there), so a remembered "age: 3" or "home_city: Milton" would only ever be the OLD
 * value arguing with it. They never ride the slice.
 */
const SHADOW_KEY =
  /(^|_)(age|ages|age_range|birthday|birthdate|birth_date|dateofbirth|date_of_birth|dob|born|grade|home_city|home_town|home_area|city|town|area|neighbou?rhood|postal|postal_code|postcode|address|municipality)(_|$)/;

/** `dateOfBirth`, `date-of-birth`, `Date of Birth` all read as `date_of_birth`. */
function shadowForm(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

/** The same three reads with the database already closed over — the shape a coach tool
 * wants, since a tool handler is handed a family and not a connection. */
export interface BoundActivityReader {
  municipality(familyId: string): Promise<Municipality | null>;
  stage(familyId: string, childId: string | null): Promise<FamilyStage | null>;
  householdNames(familyId: string): Promise<string[]>;
  familyFit?(familyId: string): Promise<FamilyFit>;
}

export function bindActivityReader(
  database: Database,
  reader: ActivityFamilyReader,
): BoundActivityReader {
  return {
    municipality: (familyId) => reader.municipality(database, familyId),
    stage: (familyId, childId) => reader.stage(database, familyId, childId),
    householdNames: (familyId) => reader.householdNames(database, familyId),
    ...(reader.familyFit
      ? { familyFit: (familyId: string) => reader.familyFit!(database, familyId) }
      : {}),
  };
}

export function productionActivityFamilyReader(): ActivityFamilyReader {
  return {
    /**
     * The ONE municipality this family's postal code names, or null.
     *
     * Null where the FSA names none or TWO, which is `selectStandingOption`'s own rule and
     * not a new one: two Thornhill FSAs genuinely straddle a municipal boundary, and the
     * table declines to guess rather than send a family the wrong town's programs. A null
     * town is not a failure — the search runs without one and the skill says so.
     */
    municipality: async (database, familyId) => {
      const [family] = await database
        .select({ areaCoarse: schema.families.areaCoarse })
        .from(schema.families)
        .where(eq(schema.families.id, familyId))
        .limit(1);
      const postal = family?.areaCoarse ?? null;
      if (postal === null) return null;
      const municipalities = municipalitiesForFsa(postal);
      return municipalities.length === 1 ? (municipalities[0] as Municipality) : null;
    },

    /**
     * The named child's stage, or the YOUNGEST child's when none was named.
     *
     * Youngest rather than eldest because that is who the constraint is: a drop-in that
     * takes a two-year-old takes a six-year-old's sibling too, and the other way round it
     * takes nobody. Derived by `deriveStage` at read time — the same age-derived floor the
     * teen redaction uses — so it is never a stored flag that can go stale.
     */
    stage: async (database, familyId, childId) => {
      const children = await database
        .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, familyId));
      if (children.length === 0) return null;
      if (childId !== null) {
        const named = children.find((child) => child.id === childId);
        return named ? deriveStage(named.dateOfBirth) : null;
      }
      const youngest = children.reduce((a, b) =>
        ageInMonths(a.dateOfBirth) <= ageInMonths(b.dateOfBirth) ? a : b,
      );
      return deriveStage(youngest.dateOfBirth);
    },

    /**
     * Every name in the household — the children's, and the parents' where they have given
     * one. All of them, not just the teens': this list is what a search query is refused
     * for containing, and there is no age at which a child's name may go to a search
     * engine.
     */
    householdNames: async (database, familyId) => {
      const [children, parents] = await Promise.all([
        database
          .select({ name: schema.children.name })
          .from(schema.children)
          .where(eq(schema.children.familyId, familyId)),
        database
          .select({ name: schema.users.name })
          .from(schema.familyMembers)
          .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
          .where(eq(schema.familyMembers.familyId, familyId)),
      ]);
      return [...children, ...parents]
        .map((row) => row.name?.trim() ?? '')
        .filter((name) => name !== '');
    },

    familyFit: async (database, familyId, now = new Date()) => {
      const self = productionActivityFamilyReader();
      const [homeArea, childRows] = await Promise.all([
        self.municipality(database, familyId),
        database
          .select({
            id: schema.children.id,
            name: schema.children.name,
            dateOfBirth: schema.children.dateOfBirth,
          })
          .from(schema.children)
          .where(eq(schema.children.familyId, familyId)),
      ]);
      const children = childRows.map((row) => toFitChild(row, now));
      const teenIds = new Set(
        children.filter((child) => child.stage === 'teenager').map((child) => child.childId),
      );
      const factRows = await database
        .select({
          childId: schema.familyMemoryFacts.childId,
          key: schema.familyMemoryFacts.factKey,
          value: schema.familyMemoryFacts.factValue,
          confidence: schema.familyMemoryFacts.confidence,
          source: schema.familyMemoryFacts.memorySource,
          sourcedAt: schema.familyMemoryFacts.sourcedAt,
        })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            inArray(schema.familyMemoryFacts.factType, [...FIT_FACT_TYPES]),
            isNull(schema.familyMemoryFacts.validUntil),
            // A passing question (`one_off`) is not a family preference (Devin, #980).
            ne(schema.familyMemoryFacts.memoryKind, 'one_off'),
            or(
              isNull(schema.familyMemoryFacts.expiresAt),
              gt(schema.familyMemoryFacts.expiresAt, now),
            ),
            // Teen facts are dropped in SQL so they never eat the LIMIT (Devin, #980).
            teenIds.size > 0
              ? or(
                  isNull(schema.familyMemoryFacts.childId),
                  notInArray(schema.familyMemoryFacts.childId, [...teenIds]),
                )
              : undefined,
          ),
        )
        // Newest first, so a pile of old high-confidence facts (held back as stale
        // anyway) cannot fill the LIMIT and starve a fresh preference (Devin, #981).
        .orderBy(
          desc(schema.familyMemoryFacts.sourcedAt),
          desc(schema.familyMemoryFacts.confidence),
          desc(schema.familyMemoryFacts.validFrom),
          schema.familyMemoryFacts.id,
        )
        .limit(FAMILY_FIT_PREFERENCE_LIMIT * 4);
      return {
        children,
        homeArea,
        ...selectFitPreferences(factRows, teenIds, now),
      };
    },
  };
}

export function toFitChild(
  row: { id: string; name: string; dateOfBirth: string },
  now: Date = new Date(),
): FamilyFitChild {
  const stage = deriveStage(row.dateOfBirth, now);
  if (stage === 'teenager') return { childId: row.id, name: null, stage, ageYears: null };
  return {
    childId: row.id,
    name: row.name.trim() || null,
    stage,
    ageYears: Math.floor(ageInMonths(row.dateOfBirth, now) / 12),
  };
}

export interface FitFactRow {
  childId: string | null;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  sourcedAt: Date;
}

function asSource(source: string): FactSource {
  return source in FACT_FRESH_DAYS ? (source as FactSource) : 'legacy';
}

/**
 * Which remembered facts may steer a pick (VIL-518/519).
 *
 * - A teen's facts never ride (rule #1/#5).
 * - A hunch below the write floor never ranks, even if an old writer let one in.
 * - A key that shadows the record's age or home area is dropped: the record wins.
 * - A fact older than its source's freshness window is held back and named in
 *   `recheck` (key only) instead of being used.
 * - One per (child, key): `writeFact` keeps one live row per identity, and a row seen
 *   later than another for the same key wins should two ever reach here.
 */
export function selectFitPreferences(
  rows: readonly FitFactRow[],
  teenIds: ReadonlySet<string>,
  now: Date = new Date(),
): { preferences: FamilyFitPreference[]; recheck: FamilyFitRecheck[] } {
  const newest = new Map<string, FitFactRow>();
  for (const row of rows) {
    if (row.childId !== null && teenIds.has(row.childId)) continue;
    if (!(row.confidence >= CONFIDENCE_FLOOR)) continue;
    if (SHADOW_KEY.test(shadowForm(row.key))) continue;
    const id = `${row.childId ?? ''}\u0000${row.key}`;
    const seen = newest.get(id);
    if (!seen || row.sourcedAt.getTime() > seen.sourcedAt.getTime()) newest.set(id, row);
  }
  const preferences: FamilyFitPreference[] = [];
  const recheck: FamilyFitRecheck[] = [];
  for (const row of newest.values()) {
    const source = asSource(row.source);
    const seenOn = row.sourcedAt.toISOString().slice(0, 10);
    const ageDays = (now.getTime() - row.sourcedAt.getTime()) / DAY_MS;
    if (ageDays > FACT_FRESH_DAYS[source]) {
      if (recheck.length < FAMILY_FIT_RECHECK_LIMIT) {
        recheck.push({ childId: row.childId, key: row.key, seenOn });
      }
      continue;
    }
    if (preferences.length < FAMILY_FIT_PREFERENCE_LIMIT) {
      preferences.push({ childId: row.childId, key: row.key, value: row.value, source, seenOn });
    }
  }
  return { preferences, recheck };
}
