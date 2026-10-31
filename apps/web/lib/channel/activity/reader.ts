import { type Database, type Municipality, schema } from '@hale/db';
import { type FamilyStage, ageInMonths, deriveStage } from '@hale/types';
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
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
}

export interface FamilyFit {
  children: FamilyFitChild[];
  /** The home municipality the search looked around, or null when unknown. */
  homeArea: Municipality | null;
  preferences: FamilyFitPreference[];
}

/** Durable facts that steer a pick: tastes (indoor, not scary, swim) and logistics
 * (stroller, language, how far they will drive). Medical/relationship/voice never ride. */
const FIT_FACT_TYPES = ['preference', 'logistic'] as const;
/** Small on purpose: a slice, not the memory. */
export const FAMILY_FIT_PREFERENCE_LIMIT = 8;

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
        .orderBy(
          desc(schema.familyMemoryFacts.confidence),
          desc(schema.familyMemoryFacts.validFrom),
          schema.familyMemoryFacts.id,
        )
        .limit(FAMILY_FIT_PREFERENCE_LIMIT * 2);
      return {
        children,
        homeArea,
        preferences: selectFitPreferences(factRows, teenIds),
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

/** A teen's preferences never ride (rule #1/#5); the rest are capped to the slice. */
export function selectFitPreferences(
  rows: readonly { childId: string | null; key: string; value: unknown }[],
  teenIds: ReadonlySet<string>,
): FamilyFitPreference[] {
  return rows
    .filter((row) => row.childId === null || !teenIds.has(row.childId))
    .slice(0, FAMILY_FIT_PREFERENCE_LIMIT)
    .map((row) => ({ childId: row.childId, key: row.key, value: row.value }));
}
