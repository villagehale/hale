import type { Municipality } from '@hale/db';
import { resolveMunicipalities } from '~/lib/registration/match-registration-windows';
import {
  EVERGREEN_VENUES,
  type EvergreenVenue,
  type EvergreenVenueKind,
} from './evergreen-venues-data';

/**
 * The standing option: one verified, always-there place for a family whose Village run
 * has nothing to offer.
 *
 * "What can we do tomorrow" used to come back empty-handed whenever no scheduled event
 * had been discovered or none had checked out — which is most weeks, early. The answer
 * is not to loosen what counts as verified (that is the launch-day hedge the Village
 * tool exists to prevent). It is to have a SECOND kind of answer available: not an
 * event, a PLACE. A free drop-in that is simply there does not need a verified date,
 * because it makes no claim about one.
 *
 * NO MODEL CHOOSES THIS. Three inputs decide it — where the family lives, how old the
 * youngest is, and what month it is — and the same three always produce the same row.
 * A model picking from 83 venues would be a model picking, and the reason a parent can
 * trust the name is that nothing generated it.
 *
 * WHAT IT REFUSES TO DO, which is most of the design:
 *
 *   It never claims a TIME. The dataset's `cadence` is prose, often "check the seasonal
 *   schedule", because that is what the sources say (evergreen-venues-data.ts caveat 1).
 *   It travels to the model exactly as written and the skill is instructed to present it
 *   as a standing venue rather than an appointment.
 *
 *   It never names a SPLASH PAD in the cold. Water play is seasonal (caveat 2), so the
 *   `park` tier is gated on {@link WARM_MONTHS} rather than left to the copy.
 *
 *   It never GUESSES a town. An unknown, uncovered or straddling FSA yields nothing —
 *   the same conservatism the registration matcher applies, for the same reason: sending
 *   a family to the next town's centre is worse than saying nothing.
 *
 *   It never hands out a URL. See {@link StandingOption}.
 */

/**
 * The months a `park` row may be offered in: July and August.
 *
 * The published seasons across the park rows do not agree — "Victoria Day-Labour Day",
 * "roughly May-Sept", "mid-May to ~Labour Day", "early June-early Sept", "mid-June-early
 * Sept" — so this is their INTERSECTION rather than any one of them, the months every
 * park row's own source says it is open. June and September are inside some seasons and
 * outside others, and a closed splash pad is the one failure this gate exists to
 * prevent; those months get the indoor answer instead.
 */
export const WARM_MONTHS: ReadonlySet<number> = new Set([7, 8]);

/** The top of the EarlyON band. The programme itself runs birth to six, but a family
 * whose youngest has started school is better served by a branch or a park than by a
 * drop-in built around babies and toddlers. */
const EARLYON_LEAD_MAX_MONTHS = 48;

/**
 * The standing venue as a MODEL sees it — four fields, and deliberately not the fifth.
 *
 * `source` is absent by construction rather than by omission. The SMS coach is forbidden
 * to write a URL at all ("Never send them to the app"), so handing it one would be
 * handing it a rule to break; the provenance stays in the dataset where a human can
 * re-check it. This mirrors `PlaybookCreator.verified`, which is likewise kept and
 * likewise never sent.
 */
export interface StandingOption {
  name: string;
  area: string;
  what: string;
  /** The source's own words about when it runs — frequently an instruction to go and
   * check, and never to be converted into a day and a time. */
  cadence: string;
}

/**
 * The kinds worth offering, best first, for this family in this month.
 *
 * `rec` is on no list. Those are the rows that cost money and carry the
 * guardian-in-the-water rule (caveats 4 and 5) — real venues, but not the shape of
 * "somewhere you can just turn up tomorrow", which is the whole promise here.
 */
function kindPriority(youngestAgeMonths: number, month: number): EvergreenVenueKind[] {
  const priority: EvergreenVenueKind[] = [];
  if (youngestAgeMonths < EARLYON_LEAD_MAX_MONTHS) priority.push('earlyon');
  if (WARM_MONTHS.has(month)) priority.push('park');
  priority.push('library');
  return priority;
}

/** The one municipality this postal code names, or null where it names none or two. */
function confidentMunicipality(postal: string): Municipality | null {
  const municipalities = resolveMunicipalities(postal);
  return municipalities.length === 1 ? (municipalities[0] as Municipality) : null;
}

/**
 * The standing venue for this family, or null when the dataset cannot honestly name one.
 *
 * `venues` is injectable so the fall-through between kinds can be exercised against a
 * municipality that is missing one — the shipped dataset carries an EarlyON row and a
 * library row for all fifteen towns, so the first tier always hits in production.
 */
export function selectStandingOption(
  input: {
    /** The family's postal code or FSA — `families.area_coarse`. */
    postal: string | null;
    /** The age of the youngest child on file, in months. Null when there are none, in
     * which case there is no band to choose for and nothing is offered. */
    youngestAgeMonths: number | null;
    /** The month in the FAMILY's own timezone, 1-12. Seasons are local. */
    month: number;
  },
  venues: readonly EvergreenVenue[] = EVERGREEN_VENUES,
): StandingOption | null {
  if (input.postal === null || input.youngestAgeMonths === null) return null;

  const municipality = confidentMunicipality(input.postal);
  if (municipality === null) return null;

  for (const kind of kindPriority(input.youngestAgeMonths, input.month)) {
    const match = venues.find((v) => v.municipality === municipality && v.kind === kind);
    if (match) {
      return { name: match.name, area: match.area, what: match.what, cadence: match.cadence };
    }
  }
  return null;
}
