import { type Database, type Municipality, schema } from '@hale/db';
import { type FamilyStage, ageInMonths, deriveStage } from '@hale/types';
import { eq } from 'drizzle-orm';
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
}

/** The same three reads with the database already closed over — the shape a coach tool
 * wants, since a tool handler is handed a family and not a connection. */
export interface BoundActivityReader {
  municipality(familyId: string): Promise<Municipality | null>;
  stage(familyId: string, childId: string | null): Promise<FamilyStage | null>;
  householdNames(familyId: string): Promise<string[]>;
}

export function bindActivityReader(
  database: Database,
  reader: ActivityFamilyReader,
): BoundActivityReader {
  return {
    municipality: (familyId) => reader.municipality(database, familyId),
    stage: (familyId, childId) => reader.stage(database, familyId, childId),
    householdNames: (familyId) => reader.householdNames(database, familyId),
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
  };
}
