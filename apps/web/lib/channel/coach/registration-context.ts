import { type Database, type RegistrationWindow, schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { eq } from 'drizzle-orm';
import { readWindows } from '~/lib/channel/intake/radar';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { formatWhenPhrase } from '~/lib/format/datetime';
import { matchRegistrationWindows } from '~/lib/registration/match-registration-windows';
import { PROGRAM_DOMAIN_LABEL } from '~/lib/registration/sequence/shortlist';
import {
  createRegistrationReader,
  readRegistrationWindows,
  registrationDate,
  registrationWhen,
  type LiveRegistrationWindow,
  type RegistrationReader,
} from '~/lib/registration/read';

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
  /** This family's applicable opening date/time, with the source's timezone. */
  opensFor: string;
  /** The residents-first date is theirs, so the general date is a different, later one. */
  residentsFirst: boolean;
  /** Set only when it differs from `opensFor` — the date everyone else gets. */
  generalOpens: string | null;
  /** The match rests on the ±6-month tolerance around a derived DOB, so hedge the band. */
  ageApproximate: boolean;
  /**
   * An approved watch is active. Date-only sources cannot support a minute reminder;
   * reminderState distinguishes a paused watch from an unapproved proposal.
   */
  watching: boolean;
  sourceUrl?: string;
  reminderState?: 'active' | 'awaiting_confirmation' | 'paused';
  minuteReminderAvailable?: boolean;
}

export interface RegistrationContextPorts {
  areaCoarse(familyId: string): Promise<string | null>;
  childAgesMonths(familyId: string, now: Date): Promise<number[]>;
  windows(areaCoarse: string, now?: Date): Promise<RegistrationWindow[]>;
  watching(familyId: string): boolean;
}

/**
 * The municipal registration windows this family can still act on, soonest first.
 *
 * Empty is the common and correct answer: no area on file, an FSA outside the covered
 * set, no child in any published band, or every window already open. Nothing here
 * invents a date to fill that.
 */
export async function loadRegistrationWindows(
  ports: RegistrationContextPorts,
  familyId: string,
  timeZone: string,
  now: Date,
): Promise<RegistrationWindowContext[]> {
  const areaCoarse = await ports.areaCoarse(familyId);
  if (areaCoarse === null) return [];

  const [childrenAgesMonths, windows] = await Promise.all([
    ports.childAgesMonths(familyId, now),
    ports.windows(areaCoarse, now),
  ]);

  const watching = ports.watching(familyId);
  return matchRegistrationWindows({ windows, postal: areaCoarse, childrenAgesMonths, now }).map(
    (match) => {
      const reading = (match.window as Partial<LiveRegistrationWindow>).reading;
      const date = reading ? registrationDate(reading, match.isResidentWindow) : null;
      const general = reading ? registrationDate(reading, false) : null;
      const generalOpens =
        match.generalOpenAt.getTime() === match.opensForFamilyAt.getTime()
          ? null
          : formatWhenPhrase(match.generalOpenAt, timeZone, now);
      return {
        town: townLabel(match.window.municipality),
        programs: [
          ...new Set(
            match.cycleWindows.map(
              (w) => `${w.cycleLabel} ${PROGRAM_DOMAIN_LABEL[w.programDomain]}`,
            ),
          ),
        ].join(', '),
        opensFor:
          reading && date
            ? registrationWhen(reading, date)
            : formatWhenPhrase(match.opensForFamilyAt, timeZone, now),
        residentsFirst: match.isResidentWindow && generalOpens !== null,
        generalOpens:
          reading && general && generalOpens ? registrationWhen(reading, general) : generalOpens,
        ageApproximate: match.ageApproximate,
        watching,
        sourceUrl: match.window.sourceUrl,
      };
    },
  );
}

/** Seed rows identify known pages/cycles only; every date comes from this turn's read.
 * Runtime adds the family's actual approved watches, not a feature-flag promise. */
export function productionRegistrationContextPorts(
  database: Database,
  reader: RegistrationReader = createRegistrationReader(),
): RegistrationContextPorts {
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
    windows: async (areaCoarse, now = new Date()) =>
      readRegistrationWindows(await readWindows(database, areaCoarse), reader, now, areaCoarse),
    // A flag is not a subscription. Actual approved watches are added by runtime.
    watching: () => false,
  };
}
