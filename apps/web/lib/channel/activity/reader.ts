import { type Database, schema } from '@hale/db';
import { type FamilyStage, ageInMonths, deriveStage } from '@hale/types';
import { type FactReader, factsForContext } from '@hale/worker/memory-context';
import { eq } from 'drizzle-orm';
import { familyLocalNow } from '~/lib/channel/coach/local-now';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { type ActivityPlace, readActivityPlace } from './place';

/**
 * THE THREE FACTS THE ACTIVITY LANE READS FROM THE DATABASE — and the whole reason it
 * reads them rather than accepting them from the model.
 *
 * The town and the age band travel with a query to Anthropic's US `web_search`: a
 * cross-border disclosure, so rule #1 governs what they may be. A model asked for "the
 * location" will happily write a street; a model asked for "the age" writes the age. Both
 * are exactly what must not cross. Resolving them HERE, from the family's place (place.ts)
 * and a date of birth, is what makes "town-level and age-band only" a property of the code
 * rather than a line in a prompt.
 *
 * The names are the third, and they are read for the opposite purpose: nothing is sent
 * with them, they are what a query is REFUSED for containing (deidentify.ts).
 */
export interface ActivityFamilyReader {
  place(database: Database, familyId: string): Promise<ActivityPlace>;
  stage(database: Database, familyId: string, childId: string | null): Promise<FamilyStage | null>;
  householdNames(database: Database, familyId: string): Promise<string[]>;
  familyFit?(
    database: Database,
    familyId: string,
    reader: FactReader,
    now?: Date,
  ): Promise<FamilyFit>;
  /** Today on the family's own clock, `YYYY-MM-DD (Weekday)`, or null when the zone is
   * unknown (VIL-435). */
  today?(database: Database, familyId: string): Promise<string | null>;
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
  /** The town the search looked around, or null when the family has none. */
  homeArea: string | null;
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
  place(familyId: string): Promise<ActivityPlace>;
  stage(familyId: string, childId: string | null): Promise<FamilyStage | null>;
  householdNames(familyId: string): Promise<string[]>;
  familyFit?(familyId: string): Promise<FamilyFit>;
  today?(familyId: string): Promise<string | null>;
  timeZone?(familyId: string): Promise<string | null>;
}

/** `factReader`: who the turn is for, so a pick is never ranked on another adult's 1:1. */
export function bindActivityReader(
  database: Database,
  reader: ActivityFamilyReader,
  factReader: FactReader,
): BoundActivityReader {
  return {
    place: (familyId) => reader.place(database, familyId),
    stage: (familyId, childId) => reader.stage(database, familyId, childId),
    householdNames: (familyId) => reader.householdNames(database, familyId),
    ...(reader.familyFit
      ? { familyFit: (familyId: string) => reader.familyFit!(database, familyId, factReader) }
      : {}),
    ...(reader.today ? { today: (familyId: string) => reader.today!(database, familyId) } : {}),
    timeZone: (familyId) => readActivityTimeZone(database, familyId),
  };
}

/** The family's own zone, or null when it was never set. Used to date a find, not sent to search. */
export async function readActivityTimeZone(
  database: Database,
  familyId: string,
): Promise<string | null> {
  return knownHouseholdTimezone(database, familyId);
}

export function productionActivityFamilyReader(): ActivityFamilyReader {
  return {
    /**
     * Today on the family's own clock (VIL-435), so a find for "today" is checked against
     * the day it is where they live. A failed read is logged by fault class and leaves
     * the day out; the find still runs.
     */
    today: async (database, familyId) => {
      try {
        const zone = await knownHouseholdTimezone(database, familyId);
        if (!zone) return null;
        const local = familyLocalNow(new Date(), zone);
        return `${local.date} (${local.weekday})`;
      } catch (err) {
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'activity reader: family day unavailable',
        );
        return null;
      }
    },
    /**
     * Where the family is now, as a search may be told it (place.ts), or why it cannot
     * be. A postal area that covers two towns is not guessed: the find does not run.
     */
    place: readActivityPlace,

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

    familyFit: async (database, familyId, factReader, now = new Date()) => {
      const self = productionActivityFamilyReader();
      const [place, childRows] = await Promise.all([
        self.place(database, familyId),
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
      // A passing question (`one_off`) is not a family preference (Devin, #980).
      const factRows = (
        await factsForContext(database, familyId, {
          now,
          reader: factReader,
          limit: FAMILY_FIT_PREFERENCE_LIMIT,
          factTypes: FIT_FACT_TYPES,
          excludeKinds: ['one_off'],
        })
      ).map((row) => ({ childId: row.childId, key: row.factKey, value: row.factValue }));
      return {
        children,
        homeArea: place.status === 'known' ? place.town : null,
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
