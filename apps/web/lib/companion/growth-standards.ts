import { ageInMonths } from '@hale/types';
import { MEASURE_KINDS, type MeasureKind } from './log-types.js';
import type { GrowthAssessmentView, GrowthBand, LogView } from './logs-view.js';
import { WHO_GROWTH_LMS, WHO_MAX_MONTH, WHO_MIN_MONTH, type WhoSex } from './who-growth-data.js';

/**
 * Deterministic WHO Child Growth Standards read (superseding the old "no growth
 * derivation" policy). This is pure math over the committed official WHO LMS tables
 * (who-growth-data.ts) — NEVER an LLM judgement. It computes a z-score for a single
 * reading and classifies it into a neutral band; it never diagnoses. The honest
 * absences (no usable sex, born preterm, out of WHO's 0–5y range) are first-class
 * results, not silent zeros.
 *
 * z-score uses the standard LMS (Box-Cox) formula:
 *   z = ((value / M) ** L − 1) / (L · S)      (L ≠ 0)
 *   z = ln(value / M) / S                     (L = 0)
 * The WHO "restricted application" adjustment (which re-scales only |z| > 3 to tame
 * the tails) is deliberately NOT implemented: our only decision boundary is |z| = 2,
 * and the adjustment leaves everything within ±3 untouched, so it cannot change a
 * band. Documented here so the omission is a choice, not an oversight.
 */

/** Born before this many completed weeks is preterm; chronological-age standards
 * would mislead, so we decline to compute (WHO/AAP corrected-age convention). */
const PRETERM_WEEKS = 37;

/** The band boundary. WHO treats ±2 SD as the "worth a closer look" line; within it
 * is the typical range. |z| exactly 2 stays 'typical' (inclusive). */
const BAND_Z = 2;

/**
 * Resolve a child's natal sex for the sex-specific WHO standard from the free-text
 * `biologicalSex` column. Only unambiguous clinical-sex tokens are honoured
 * (male/female/m/f, case-insensitive); anything else — null, empty, 'intersex',
 * 'nonbinary', 'unknown' — yields null (→ no assessment).
 *
 * The `gender` enum is intentionally NOT a fallback: its values (boy/girl/nonbinary/
 * unspecified) encode gender identity, not natal sex, and WHO growth standards are
 * keyed on natal sex — mapping 'boy'→male would be medically wrong for a trans child.
 * So sex comes from `biologicalSex` alone, or not at all.
 */
export function resolveBiologicalSex(biologicalSex: string | null | undefined): WhoSex | null {
  if (!biologicalSex) return null;
  const token = biologicalSex.trim().toLowerCase();
  if (token === 'male' || token === 'm') return 'male';
  if (token === 'female' || token === 'f') return 'female';
  return null;
}

/** The LMS z-score for a positive measurement against an (L, M, S) triple. Pure. */
export function lmsZScore(value: number, l: number, m: number, s: number): number {
  if (l === 0) return Math.log(value / m) / s;
  return ((value / m) ** l - 1) / (l * s);
}

/** Classify a z-score into its neutral band: 'typical' within ±2 SD, else 'review'. */
export function bandForZ(z: number): GrowthBand {
  return Math.abs(z) <= BAND_Z ? 'typical' : 'review';
}

/** The outcome of assessing one reading — an honest state, never a diagnosis. */
export type GrowthState =
  | { state: 'assessed'; z: number; band: GrowthBand }
  | { state: 'needs-details' }
  | { state: 'preterm' }
  | { state: 'out-of-range' };

/**
 * Assess ONE reading against the WHO standard for its measure + sex + age. Pure.
 * Precedence is deliberate: prematurity is checked first (adding a sex later must
 * not flip a preterm baby into a chronological-age computation), then a usable sex,
 * then the age/value being in the tables' domain, and only then the z-score.
 */
export function assessGrowth(input: {
  measureKind: MeasureKind;
  valueMetric: number;
  ageMonths: number;
  biologicalSex: string | null | undefined;
  gestationalWeeks: number | null | undefined;
}): GrowthState {
  const { measureKind, valueMetric, ageMonths, biologicalSex, gestationalWeeks } = input;

  // Only an EXPLICIT <37 weeks gates: an unknown gestation is not evidence of
  // prematurity, so we don't invent a caveat — we compute and lean on the caveat line.
  if (typeof gestationalWeeks === 'number' && gestationalWeeks < PRETERM_WEEKS) {
    return { state: 'preterm' };
  }

  const sex = resolveBiologicalSex(biologicalSex);
  if (!sex) return { state: 'needs-details' };

  const month = Math.floor(ageMonths);
  const row =
    month >= WHO_MIN_MONTH && month <= WHO_MAX_MONTH
      ? WHO_GROWTH_LMS[measureKind][sex][month]
      : undefined;
  if (!row || !(valueMetric > 0)) return { state: 'out-of-range' };

  const z = lmsZScore(valueMetric, row.l, row.m, row.s);
  return { state: 'assessed', z, band: bandForZ(z) };
}

/** A measurement log that carries the lifted numerics we can chart/assess. */
function latestByKind(logs: LogView[], kind: MeasureKind): LogView | null {
  let latest: LogView | null = null;
  for (const log of logs) {
    if (log.episodeType !== 'measurement') continue;
    if (log.measureKind !== kind) continue;
    if (typeof log.value !== 'number') continue;
    if (!latest || log.occurredAt > latest.occurredAt) latest = log;
  }
  return latest;
}

/**
 * Build the per-measure WHO read for a single child's measurement page. Operates on
 * the already-redacted `logs` (teen readings are gone before they reach here, rule
 * #1) and on the child's own dob/sex/gestation. Age is the child's age AT the
 * reading's date, not today — a measurement is judged against the age it was taken.
 * A kind with no reading, or one outside WHO's 0–5y range, is omitted (honest
 * absence) rather than surfaced as a fake verdict.
 */
export function buildGrowthAssessments(
  logs: LogView[],
  child: { dateOfBirth: string; biologicalSex: string | null; gestationalWeeks: number | null },
): GrowthAssessmentView[] {
  const out: GrowthAssessmentView[] = [];
  for (const kind of MEASURE_KINDS) {
    const latest = latestByKind(logs, kind);
    if (!latest || typeof latest.value !== 'number') continue;
    const assessment = assessGrowth({
      measureKind: kind,
      valueMetric: latest.value,
      ageMonths: ageInMonths(child.dateOfBirth, new Date(latest.occurredAt)),
      biologicalSex: child.biologicalSex,
      gestationalWeeks: child.gestationalWeeks,
    });
    if (assessment.state === 'out-of-range') continue;
    if (assessment.state === 'assessed') {
      out.push({ measureKind: kind, state: 'assessed', z: assessment.z, band: assessment.band });
    } else {
      out.push({ measureKind: kind, state: assessment.state });
    }
  }
  return out;
}
