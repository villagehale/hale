import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { RegistrationWindowContext } from '~/lib/channel/coach/registration-context';
import { matchPostalToken } from '~/lib/channel/off-domain/place';
import type { VerifiedRegistrationReading } from '../live-reading';
import { winterCycleLabel } from './cycle';
import { ownCityRegistrationEnabled } from './flag';
import { familyOpening, openingInstant, openingPhrase } from './opening';
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
  /** Every calendar day the line states, as the page prints it: what a tell is keyed on,
   * so a moved date of either is a new tell, and a re-read that drops the printed time is
   * still the same one. */
  statedDates: readonly string[];
  generalOpens: string | null;
  /** The one line this family is told, each date with who it is for: the tell's `what`,
   * and the facts a mid-signup answer is written from, so the two never differ. */
  line: string;
  /** Each date as the line prints it, which must reach the parent unchanged. */
  phrases: readonly string[];
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
  const town = place.city;
  const programs = reading.programOnPage ?? cycleLabel;
  const statedDates = opening.general
    ? [opening.own.date, opening.general.date]
    : [opening.own.date];
  if (opensAt.getTime() <= now.getTime()) {
    // In doubt, the residents' morning may never have been theirs: everyone's still is.
    // Keyed on both openings, so a parent already told both is not told again.
    const later = opening.residencyInDoubt ? opening.general : null;
    if (later === null) return null;
    const laterAt = openingInstant(reading, later);
    if (laterAt.getTime() <= now.getTime()) return null;
    const phrase = openingPhrase(reading, later, now);
    return {
      town,
      programs,
      opensFor: phrase,
      opensAt: laterAt,
      statedDates,
      generalOpens: null,
      line: `${town} ${programs} registration opens ${phrase}`,
      phrases: [phrase],
    };
  }
  const own = openingPhrase(reading, opening.own, now);
  const general = opening.general ? openingPhrase(reading, opening.general, now) : null;
  // Residency in doubt: both mornings in the one field, each with who it is for, so no
  // reader can keep the earlier one and drop the condition.
  const opensFor =
    opening.residencyInDoubt && general !== null
      ? `${own} if they live in ${town}, otherwise ${general}`
      : own;
  const generalOpens = opening.residencyInDoubt ? null : general;
  return {
    town,
    programs,
    opensFor,
    opensAt,
    statedDates,
    generalOpens,
    line:
      generalOpens === null
        ? `${town} ${programs} registration opens ${opensFor}`
        : `${town} ${programs} registration opens ${own} for ${town} residents; everyone else ${generalOpens}`,
    phrases: general === null ? [own] : [own, general],
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

/** This place's own opening off its own page, or null: none on file, or already open. */
async function ownCityOpening(
  database: Database,
  place: OwnCity,
  now: Date,
): Promise<CityOpeningFacts | null> {
  const cycleLabel = winterCycleLabel(now);
  const stored = await latestCityReading(database, place, cycleLabel);
  if (stored?.status !== 'verified') return null;
  return cityOpeningFacts(place, cycleLabel, stored.reading, now);
}

/**
 * A parent mid-signup, before there is a family: the opening of the town their postal
 * code is in, or null with none on file. Read the way a family's place is read
 * (place.ts), off the code alone, and worded the way the family's own tell is
 * (cityOpeningFacts), so the answer mid-signup is the line they are later told. The
 * country is the code's own: a Canadian FSA or a US ZIP.
 */
export async function postalOwnCityOpening(
  database: Database,
  postal: string,
  now: Date,
): Promise<CityOpeningFacts | null> {
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
  return ownCityOpening(database, own.place, now);
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
  const facts = await ownCityOpening(database, own.place, now);
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
