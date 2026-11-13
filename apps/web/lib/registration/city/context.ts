import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { RegistrationWindowContext } from '~/lib/channel/coach/registration-context';
import { matchPostalToken } from '~/lib/channel/off-domain/place';
import type { VerifiedRegistrationReading } from '../live-reading';
import { winterCycleLabel } from './cycle';
import { ownCityRegistrationEnabled } from './flag';
import { familyOpening, openingInstant, openingPhrase, openingQuote } from './opening';
import { type OwnCity, ownCityOfRow, readOwnCity } from './place';
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
  /** When this family can first register; for a family whose residency is in doubt,
   * the residents' morning and everyone else's, each with who it is for. */
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
  if (opensAt.getTime() <= now.getTime()) {
    // In doubt, the residents' morning may never have been theirs: everyone's still is.
    // Keyed on the first opening, so a parent already told both is not told again.
    const later = opening.residencyInDoubt ? opening.general : null;
    if (later === null) return null;
    const laterAt = openingInstant(reading, later);
    if (laterAt.getTime() <= now.getTime()) return null;
    return {
      town: place.city,
      programs: reading.programOnPage ?? cycleLabel,
      opensFor: openingPhrase(reading, later, now),
      opensAt: laterAt,
      openingDate: opening.own.date,
      generalOpens: null,
    };
  }
  const own = openingPhrase(reading, opening.own, now);
  const general = opening.general ? openingPhrase(reading, opening.general, now) : null;
  return {
    town: place.city,
    programs: reading.programOnPage ?? cycleLabel,
    // Residency in doubt: both mornings in the one field, each with who it is for, so no
    // reader can keep the earlier one and drop the condition.
    opensFor: opening.residencyInDoubt
      ? `${own} if they live in ${place.city}, otherwise ${general}`
      : own,
    opensAt,
    openingDate: opening.own.date,
    generalOpens: opening.residencyInDoubt ? null : general,
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

/** This place's own opening off its own page, with the page's own words for each of its
 * dates, or null: none on file, or already open. */
async function ownCityOpening(
  database: Database,
  place: OwnCity,
  now: Date,
): Promise<{ facts: CityOpeningFacts; quotes: string[] } | null> {
  const cycleLabel = winterCycleLabel(now);
  const stored = await latestCityReading(database, place, cycleLabel);
  if (stored?.status !== 'verified') return null;
  const facts = cityOpeningFacts(place, cycleLabel, stored.reading, now);
  const opening = familyOpening(stored.reading, place);
  if (facts === null || opening === null) return null;
  const dates = opening.general ? [opening.own, opening.general] : [opening.own];
  return { facts, quotes: dates.map((date) => openingQuote(date, place.district)) };
}

/**
 * A parent mid-signup, before there is a family: the page's own words for the opening of
 * the town their postal code is in, or null with none on file. Read the way a family's
 * place is read (place.ts), off the code alone, and chosen the way the family's own tell
 * is (familyOpening), so the answer mid-signup is the date they are later told. The
 * country is the code's own: a Canadian FSA or a US ZIP.
 */
export async function postalOwnCityQuotes(
  database: Database,
  postal: string,
  now: Date,
): Promise<string[] | null> {
  if (!ownCityRegistrationEnabled()) return null;
  const token = matchPostalToken(postal);
  if (token === null) return null;
  const own = await ownCityOfRow({
    country: token.countryName,
    province: null,
    city: null,
    postalCode: postal,
    areaCoarse: null,
  });
  if (own.status !== 'known') return null;
  return (await ownCityOpening(database, own.place, now))?.quotes ?? null;
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
  const opening = await ownCityOpening(database, own.place, now);
  if (opening === null) return [];
  const { facts } = opening;
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
