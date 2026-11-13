import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { eq } from 'drizzle-orm';
import { f14EnabledFor } from '~/lib/channel/f14';
import { readWindows } from '~/lib/channel/intake/radar';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { formatWhenPhrase } from '~/lib/format/datetime';
import { ownCityRegistrationContext } from '~/lib/registration/city/context';
import {
  type RegistrationMatch,
  matchRegistrationWindows,
} from '~/lib/registration/match-registration-windows';
import { PROGRAM_DOMAIN_LABEL } from '~/lib/registration/sequence/shortlist';

/**
 * THE RADAR, VISIBLE TO THE COACH (2026-08-21 answer-quality probe).
 *
 * Hale's flagship job is the registration morning: hand-verified municipal open dates
 * in `registration_windows`, and a ladder that claims a matched window ten days out,
 * warns a week out, hands over a plan the evening before and taps the parent fifteen
 * minutes before the doors open (registration/sequence/run.ts).
 *
 * A texted turn could see NONE of it. Every path into that machinery was a sweep — the
 * intake radar, the daily nudge, the M7 ladder — and none of them is reachable from a
 * parent asking a question, so the coach answered as though the job did not exist:
 *
 *   "what is there for the fall" got three web finds and no Sept 1 date, or the date
 *   re-discovered by `find_activities` and stamped "their site says" — a WEAKER claim
 *   than the truth, on a fact Hale had verified by hand.
 *
 *   "can you watch swim registration this fall" got "watching for registration
 *   openings isn't something I can do yet - I can't monitor a site and ping you when
 *   it changes." Every clause of that is false, and the skill made it the correct
 *   reply: what Hale can do is what its tools and context say, and neither said this.
 *
 * So the facts ride the context, the way the schedule and the standing questions do.
 * Not a tool: a date this family must act on is not something the model should have to
 * think to go and look for, and the turn it would spend looking is a turn a parent is
 * waiting through.
 *
 * WHAT IS AND IS NOT CLAIMED. `opensFor` is this family's own date — the residents-first
 * one only where their FSA resolves to exactly one town that publishes it, which is
 * `resolveFamilyOpen`'s rule and not a second copy of it. `watching` is read from the
 * ladder's OWN arming predicate (`f14EnabledFor`), so a family the sweep is dark for is
 * never told Hale is on it. An unknown FSA yields nothing at all, because a neighbouring
 * town's dates are worse than silence (rule M1).
 */
export interface RegistrationWindowContext {
  /** `Halton Hills`, as a parent says it. */
  town: string;
  /** What opens — `Fall 2026 recreation programs`. */
  programs: string;
  /** When THIS family can first register, in their zone: `Sep 1, 7:00 a.m.` */
  opensFor: string;
  /** The residents-first date is theirs, so the general date is a different, later one. */
  residentsFirst: boolean;
  /** Set only when it differs from `opensFor` — the date everyone else gets. */
  generalOpens: string | null;
  /** The match rests on the ±6-month tolerance around a derived DOB, so hedge the band. */
  ageApproximate: boolean;
  /**
   * Hale's registration ladder is armed for this family and this window: it will text
   * a week ahead, the evening before, and fifteen minutes before the doors open.
   * FALSE means the sweep is dark for them and nothing is being watched.
   */
  watching: boolean;
}

export interface RegistrationContextPorts {
  areaCoarse(familyId: string): Promise<string | null>;
  childAgesMonths(familyId: string, now: Date): Promise<number[]>;
  windows(areaCoarse: string): Promise<RegistrationWindow[]>;
  watching(familyId: string): boolean;
  /**
   * VIL-684 · the family's own city's opening, read off that city's official page and
   * cached per city. Asked only when no hand-verified window matches the family, so one
   * season is never two sources. Per parent: whether a tell is waiting is this parent's.
   */
  ownCity(familyId: string, parentUserId: string, now: Date): Promise<RegistrationWindowContext[]>;
}

/** The hand-verified windows this family can still act on. Empty with no area on file. */
export async function matchHandWindows(
  ports: Pick<RegistrationContextPorts, 'areaCoarse' | 'childAgesMonths' | 'windows'>,
  familyId: string,
  now: Date,
): Promise<RegistrationMatch[]> {
  const areaCoarse = await ports.areaCoarse(familyId);
  if (areaCoarse === null) return [];
  const [childrenAgesMonths, windows] = await Promise.all([
    ports.childAgesMonths(familyId, now),
    ports.windows(areaCoarse),
  ]);
  return matchRegistrationWindows({ windows, postal: areaCoarse, childrenAgesMonths, now });
}

/**
 * The municipal registration windows this family can still act on, soonest first.
 *
 * Empty is the common and correct answer: no area on file, an FSA outside the covered
 * set, no child in any published band, or every window already open, and no verified
 * opening on the family's own city's page either. Nothing here invents a date to fill
 * that.
 */
export async function loadRegistrationWindows(
  ports: RegistrationContextPorts,
  familyId: string,
  parentUserId: string,
  timeZone: string,
  now: Date,
): Promise<RegistrationWindowContext[]> {
  const matches = await matchHandWindows(ports, familyId, now);
  if (matches.length === 0) return ports.ownCity(familyId, parentUserId, now);

  const watching = ports.watching(familyId);
  return matches.map((match) => {
    const generalOpens =
      match.generalOpenAt.getTime() === match.opensForFamilyAt.getTime()
        ? null
        : formatWhenPhrase(match.generalOpenAt, timeZone, now);
    return {
      town: townLabel(match.window.municipality),
      programs: [
        ...new Set(
          match.cycleWindows.map((w) => `${w.cycleLabel} ${PROGRAM_DOMAIN_LABEL[w.programDomain]}`),
        ),
      ].join(', '),
      opensFor: formatWhenPhrase(match.opensForFamilyAt, timeZone, now),
      residentsFirst: match.isResidentWindow && generalOpens !== null,
      generalOpens,
      ageApproximate: match.ageApproximate,
      watching,
    };
  });
}

/** The live wiring: the family's own FSA and children, the seeded window table, and the
 * ladder's own flag. `readWindows` is the intake radar's reader, shared rather than
 * re-queried, so the coach can never be looking at a different window set than the
 * sweep that will do the work. */
export function productionRegistrationContextPorts(database: Database): RegistrationContextPorts {
  return {
    areaCoarse: async (familyId) => {
      const [row] = await database
        .select({ areaCoarse: schema.families.areaCoarse })
        .from(schema.families)
        .where(eq(schema.families.id, familyId));
      return row?.areaCoarse ?? null;
    },
    childAgesMonths: async (familyId, now) => {
      const rows = await database
        .select({ dateOfBirth: schema.children.dateOfBirth })
        .from(schema.children)
        .where(eq(schema.children.familyId, familyId));
      return rows.map((row) => ageInMonths(row.dateOfBirth, now));
    },
    windows: (areaCoarse) => readWindows(database, areaCoarse),
    watching: (familyId) => f14EnabledFor(familyId),
    // Optional data, like the provider watch: a failed read leaves the city out rather
    // than failing the parent's turn, and the coach then has no date for their town. The
    // line names the fault class only.
    ownCity: (familyId, parentUserId, now) =>
      ownCityRegistrationContext(database, familyId, parentUserId, now).catch((err: unknown) => {
        console.error(
          { fault: err instanceof Error ? err.name : typeof err },
          'coach: own-city registration context unavailable',
        );
        return [];
      }),
  };
}
