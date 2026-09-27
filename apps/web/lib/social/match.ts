import type { GtaRegion, Municipality, SocialCategory } from '@hale/db';
import { municipalitiesForFsa } from '~/lib/registration/fsa-municipalities';

/**
 * VIL-378 — who may hear about a social spot.
 *
 * A spot alerts only when age, area, timing, confidence, and mute all pass.
 * A miss is a named reason. Hale does not guess an age or a city, and this
 * module does not compose a message.
 */

/** Below this the spot stays in the review queue. Same bar as civic hours. */
export const SOCIAL_ALERT_CONFIDENCE = 0.7;

/** Soft pad so a caption that says "ages 3–5" still reaches a child who just turned 6. */
export const AGE_PAD_YEARS = 1;

/** How far ahead a dated activity still belongs on the year plan. */
export const PLANNING_HORIZON_DAYS = 45;

/** A registration that opens inside this window is urgent enough to surface. */
export const REGISTRATION_LEAD_DAYS = 7;

const MUNICIPALITY_REGION: Record<Municipality, GtaRegion> = {
  toronto: 'toronto',
  mississauga: 'peel',
  brampton: 'peel',
  caledon: 'peel',
  markham: 'york',
  vaughan: 'york',
  richmond_hill: 'york',
  whitchurch_stouffville: 'york',
  newmarket: 'york',
  aurora: 'york',
  king: 'york',
  east_gwillimbury: 'york',
  georgina: 'york',
  oakville: 'halton',
  burlington: 'halton',
  halton_hills: 'halton',
  ajax: 'durham',
  pickering: 'durham',
  whitby: 'durham',
  oshawa: 'durham',
  uxbridge: 'durham',
};

/**
 * Milton's urban FSAs. The registration table omits Milton (its rec mornings
 * are not in that radar). Canada Post lists both under Milton, which is Halton.
 */
const MILTON_FSAS: Readonly<Record<string, GtaRegion>> = {
  L9T: 'halton',
  L9E: 'halton',
};

export type SocialAlertReason =
  | 'alert'
  | 'muted'
  | 'low_confidence'
  | 'no_children'
  | 'age_unstated'
  | 'age_mismatch'
  | 'no_area'
  | 'area_mismatch'
  | 'no_date'
  | 'outside_horizon'
  | 'already_alerted';

export interface FamilySocialProfile {
  /** Completed years for each child Hale may match. Empty means no child on file. */
  childAgesYears: number[];
  /** Forward sortation area, already coarsened. Null when the household has not given one. */
  fsa: string | null;
  /** Set when the household named a region. Otherwise the FSA is asked. */
  region: GtaRegion | null;
  /** Farms and safari parks outside the five regions. */
  dayTripOk: boolean;
  mutedCategories: SocialCategory[];
}

export interface SpotForMatch {
  category: SocialCategory;
  region: GtaRegion;
  geoFsa: string | null;
  ageMin: number | null;
  ageMax: number | null;
  startsAt: Date | null;
  registrationOpensAt: Date | null;
  confidence: number;
  alreadyAlerted: boolean;
}

export interface SocialMatch {
  alert: boolean;
  reason: SocialAlertReason;
}

export function regionForFsa(fsa: string | null | undefined): GtaRegion | null {
  if (!fsa) return null;
  const code = fsa.trim().toUpperCase().slice(0, 3);
  if (code.length < 3) return null;
  const extra = MILTON_FSAS[code];
  const towns = municipalitiesForFsa(code);
  if (towns.length === 0) return extra ?? null;
  const regions = new Set(towns.map((town) => MUNICIPALITY_REGION[town]));
  if (regions.size !== 1) return extra ?? null;
  return [...regions][0] ?? null;
}

function agesOverlap(childYears: number, ageMin: number | null, ageMax: number | null): boolean {
  const low = (ageMin ?? 0) - AGE_PAD_YEARS;
  const high = (ageMax ?? 18) + AGE_PAD_YEARS;
  return childYears >= low && childYears <= high;
}

function areaMatches(family: FamilySocialProfile, spot: SpotForMatch): SocialAlertReason | null {
  const familyFsa = family.fsa?.trim().toUpperCase().slice(0, 3) ?? null;
  const spotFsa = spot.geoFsa?.trim().toUpperCase().slice(0, 3) ?? null;
  if (familyFsa && spotFsa && familyFsa === spotFsa) return null;

  const familyRegion = family.region ?? regionForFsa(family.fsa);
  if (!familyRegion && !familyFsa) return 'no_area';
  if (spot.region === 'day_trip') {
    return family.dayTripOk ? null : 'area_mismatch';
  }
  if (familyRegion && familyRegion === spot.region) return null;
  return 'area_mismatch';
}

function timingMatches(spot: SpotForMatch, now: Date): SocialAlertReason | null {
  const horizon = PLANNING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const lead = REGISTRATION_LEAD_DAYS * 24 * 60 * 60 * 1000;
  if (spot.registrationOpensAt) {
    const delta = spot.registrationOpensAt.getTime() - now.getTime();
    if (delta <= lead && delta >= -24 * 60 * 60 * 1000) return null;
  }
  if (!spot.startsAt && !spot.registrationOpensAt) return 'no_date';
  if (spot.startsAt) {
    const delta = spot.startsAt.getTime() - now.getTime();
    if (delta >= 0 && delta <= horizon) return null;
  }
  return 'outside_horizon';
}

/**
 * Whether this spot may be offered to this family. The first failing gate wins,
 * in an order that keeps a mute louder than a near-miss on age.
 */
export function matchSocialSpot(
  family: FamilySocialProfile,
  spot: SpotForMatch,
  now: Date,
): SocialMatch {
  if (family.mutedCategories.includes(spot.category)) return { alert: false, reason: 'muted' };
  if (spot.confidence < SOCIAL_ALERT_CONFIDENCE) {
    return { alert: false, reason: 'low_confidence' };
  }
  if (family.childAgesYears.length === 0) return { alert: false, reason: 'no_children' };
  if (spot.ageMin === null && spot.ageMax === null) {
    return { alert: false, reason: 'age_unstated' };
  }
  const ageHit = family.childAgesYears.some((years) =>
    agesOverlap(years, spot.ageMin, spot.ageMax),
  );
  if (!ageHit) return { alert: false, reason: 'age_mismatch' };

  const area = areaMatches(family, spot);
  if (area) return { alert: false, reason: area };

  const timing = timingMatches(spot, now);
  if (timing) return { alert: false, reason: timing };

  if (spot.alreadyAlerted) return { alert: false, reason: 'already_alerted' };
  return { alert: true, reason: 'alert' };
}
