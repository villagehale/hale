import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { RegistrationWindowContext } from '~/lib/channel/coach/registration-context';
import type { VerifiedRegistrationReading } from '../live-reading';
import { winterCycleLabel } from './cycle';
import { ownCityRegistrationEnabled } from './flag';
import { familyOpening, openingInstant, openingPhrase } from './opening';
import { type OwnCity, readOwnCity } from './place';
import { latestCityReading } from './store';

/**
 * VIL-684 · the family's own city's opening, in the coach's registration-window shape:
 * the town, the season, when THIS family can first register, and the later date for
 * everyone else where the page prints one. Built from the cached reading only; the
 * coach never waits on a search. No reading, or one that verified no opening, is no
 * entry, and the coach then says it has no date for their town yet.
 */

export const REGISTRATION_OPENING_KIND = 'registration_opening';

export interface CityOpeningFacts {
  town: string;
  /** The page's own name for the programs, or the season alone where the page gives
   * none: never a broader label than the page's. */
  programs: string;
  opensFor: string;
  opensAt: Date;
  /** The opening's calendar day as the page prints it: what a tell is keyed on, so a
   * re-read that drops the printed time is still the same opening. */
  openingDate: string;
  generalOpens: string | null;
}

/** This family's opening on a verified page, or null when the page has none for them or
 * it has already opened. */
export function cityOpeningFacts(
  place: OwnCity,
  cycleLabel: string,
  reading: VerifiedRegistrationReading,
  now: Date,
): CityOpeningFacts | null {
  const opening = familyOpening(reading, place);
  if (opening === null) return null;
  const opensAt = openingInstant(reading, opening.own);
  if (opensAt.getTime() <= now.getTime()) return null;
  return {
    town: place.city,
    programs: reading.programOnPage ?? cycleLabel,
    opensFor: openingPhrase(reading, opening.own, now),
    opensAt,
    openingDate: opening.own.date,
    generalOpens: opening.general ? openingPhrase(reading, opening.general, now) : null,
  };
}

/** A tell is queued or held for THIS parent: Hale will text them before it opens. A
 * co-parent's tell is not this parent's, and the gate may have held theirs. */
async function tellPending(
  database: Database,
  familyId: string,
  parentUserId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.proactiveCandidates.id })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.parentUserId, parentUserId),
        eq(schema.proactiveCandidates.kind, REGISTRATION_OPENING_KIND),
        inArray(schema.proactiveCandidates.status, ['queued', 'held']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function ownCityRegistrationContext(
  database: Database,
  familyId: string,
  parentUserId: string,
  now: Date,
): Promise<RegistrationWindowContext[]> {
  if (!ownCityRegistrationEnabled()) return [];
  const own = await readOwnCity(database, familyId);
  if (own.status !== 'known') return [];
  const cycleLabel = winterCycleLabel(now);
  const stored = await latestCityReading(database, own.place, cycleLabel);
  if (stored?.status !== 'verified') return [];
  const facts = cityOpeningFacts(own.place, cycleLabel, stored.reading, now);
  if (facts === null) return [];
  return [
    {
      town: facts.town,
      programs: facts.programs,
      opensFor: facts.opensFor,
      residentsFirst: facts.generalOpens !== null,
      generalOpens: facts.generalOpens,
      ageApproximate: false,
      watching: await tellPending(database, familyId, parentUserId),
    },
  ];
}
