import { type CrisisRegion, crisisFactsForRegion } from './crisis-resources';

/**
 * The line Hale may hand a model when a child is hurt or ill and it is not a crisis
 * (VIL-589, D1). Facts to weave in, never a sentence.
 *
 * 911 is correct everywhere Hale serves. A regional number goes out only for a region
 * whose official source names it, and today that is Ontario alone. Everyone else (a US
 * family, a family in another province, a family Hale cannot place) is told their
 * child's doctor's after-hours line, which carries no number. In the US 811 is the
 * call-before-you-dig line, so it must never reach a US parent.
 *
 * Alias-free and relative imports only, so the said-line eval can import it as-is.
 */

export interface HealthPlace {
  readonly country: CrisisRegion;
  /** The postal table's own spelling of the province or state, or null. */
  readonly provinceOrState: string | null;
}

export type HealthLineBasis =
  | 'ontario'
  | 'province_unverified'
  | 'canada_province_unknown'
  | 'united_states'
  | 'region_unknown';

export interface HealthLineFacts {
  /** Logged with the outcome, never sent to the model. Names a province at most. */
  readonly basis: HealthLineBasis;
  readonly facts: { readonly healthLine: string; readonly emergency: '911' };
  /** Every number the reply must carry, derived from the facts: never a list literal. */
  readonly mustInclude: readonly string[];
}

interface VerifiedLine {
  readonly basis: HealthLineBasis;
  readonly line: string;
  readonly dial: string;
}

/**
 * Keyed by the postal table's province name (off-domain/postal-cities). A row is added
 * only with an official provincial government source quoted in its PR.
 */
const VERIFIED_PROVINCE_LINES: ReadonlyMap<string, VerifiedLine> = new Map([
  ['Ontario', { basis: 'ontario', line: 'Health811 (Ontario), call 811, any time', dial: '811' }],
]);

const DOCTOR_AFTER_HOURS = "your child's doctor's after-hours line";

function basisWithoutRow(place: HealthPlace | null): HealthLineBasis {
  if (place === null) return 'region_unknown';
  if (place.country === 'US') return 'united_states';
  return place.provinceOrState === null ? 'canada_province_unknown' : 'province_unverified';
}

export function healthLineFacts(place: HealthPlace | null): HealthLineFacts {
  const { emergency } = crisisFactsForRegion(null, 'emergency');
  const row =
    place?.country === 'CA' && place.provinceOrState !== null
      ? VERIFIED_PROVINCE_LINES.get(place.provinceOrState)
      : undefined;
  if (row) {
    return {
      basis: row.basis,
      facts: { healthLine: row.line, emergency },
      mustInclude: [row.dial, emergency],
    };
  }
  return {
    basis: basisWithoutRow(place),
    facts: { healthLine: DOCTOR_AFTER_HOURS, emergency },
    mustInclude: [emergency],
  };
}
