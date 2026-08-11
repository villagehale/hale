import { TEENAGER_START_MONTHS } from '@hale/types';

/**
 * VIL-243 · M8 — the Ontario health-ADMIN checkpoint table.
 *
 * D11, stated plainly: in Ontario a parent — not the clinic — is legally the one who
 * files a child's immunization record with the local health unit ("Health-care
 * providers do not report these records for you", ontario.ca). Toronto Public Health
 * then reviews those records against the school roll, and the families who lose are
 * the ones who did the medicine and missed the PAPERWORK. That is the entire job of
 * this module: track the administrative windows, and say the boring true thing at the
 * moment it is still cheap to act on.
 *
 * THREE RULES, and they are what makes this shippable rather than reckless:
 *
 *   1. EVERY row is a TASK FOR THE PARENT, never a statement about the child. "Ontario
 *      schedules a visit at 6 months" is a fact about a schedule. "Maya is due for her
 *      6-month shots" is a claim about Maya that Hale cannot support — Hale has never
 *      seen her record and never will (health-data ingestion is explicitly out of
 *      scope). The copy lint in framing.ts enforces the vocabulary; this comment
 *      enforces the intent.
 *
 *   2. NO VACCINE OR CONDITION IS EVER NAMED. Not for teens, not for infants. Naming
 *      one would turn an admin reminder into clinical content, which is the line this
 *      feature must not cross — and it would give the teen-redaction rule (#1) a much
 *      harder job than it needs. The row links the official schedule instead.
 *
 *   3. HALE NEVER SAYS A FAMILY IS LATE, because a checkpoint is only ever surfaced
 *      while the family is INSIDE its window (see match.ts). There is no "behind" to
 *      express, by construction rather than by careful wording — which is why the
 *      "every family's timing varies" posture survives contact with a template.
 *
 * Sources are the province and the city, verified live, and each row carries both the
 * citation it rests on and the SHORT link that actually fits in an SMS.
 */

/** 13+ in completed months, from the shared stage boundaries — never a literal. */
export const TEEN_STAGE_MIN_MONTHS = TEENAGER_START_MONTHS;

/**
 * The longest URL that may ride in a message. An SMS is billed per segment and a
 * 120-character city URL would eat one on its own, so a row whose citation is long
 * links the ACTION page instead and keeps the citation for review.
 */
export const MAX_LINK_URL_LENGTH = 70;

/** Where a checkpoint applies. 'toronto' rows are Toronto Public Health's own
 * programs and must never be shown to a family outside the city. */
export type HealthRegion = 'ontario' | 'toronto';

export interface HealthCheckpoint {
  id: string;
  region: HealthRegion;
  /** The window, in completed months, during which the task is worth doing. */
  minMonths: number;
  maxMonths: number;
  /** True when the task recurs once per SCHOOL YEAR rather than once in a childhood. */
  annual: boolean;
  /** What the PARENT does. Administrative; never a claim about the child. */
  task: string;
  /** What to have in hand. Dropped entirely from a teen render (fail-closed). */
  detail: string | null;
  /**
   * The generic form, for a 13+ child (rule #1). null means this row is NEVER surfaced
   * for a teenager — silence rather than a specific. Required in practice for any row
   * a teen can reach; framing.test.ts is the gate.
   */
  teenSafeTask: string | null;
  /** The short official URL that goes IN the message. */
  linkUrl: string;
  /** The official page this row rests on. May be longer than {@link MAX_LINK_URL_LENGTH}. */
  sourceUrl: string;
  /** True when the task IS booking a visit — the only rows allowed to offer the
   * book_checkup draft escalation. */
  booking: boolean;
}

const ONTARIO_SCHOOL_VACCINES = 'https://www.ontario.ca/page/vaccines-children-school';
const ONTARIO_ROUTINE_SCHEDULE = 'https://www.ontario.ca/page/ontarios-routine-immunization-schedule';
const ONTARIO_18_MONTH_VISIT = 'https://www.ontario.ca/page/enhanced-18-month-well-baby-visit';
const ONTARIO_DENTAL = 'https://www.ontario.ca/page/get-dental-care';
const ICON_PORTAL = 'https://tph.icon.ehealthontario.ca/#!/welcome';
const TPH_REPORT_STUDENT_VACCINATION =
  'https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/immunization/report-student-vaccination/';

/**
 * The single fact most parents do not know, and the whole point of D11.
 *
 * It rides ONLY on rows whose link is the vaccines-and-school page, because that is the
 * page carrying it ("Health-care providers do not report these records for you"). The
 * routine-schedule page does not say it, so putting this line on a row that links there
 * would send a parent to a page that does not contain the instruction they were given.
 *
 * It is also absent from the infant rows for a second reason: the reporting duty
 * attaches at child care and school (ISPA/CCEYA), so asserting it to the parent of a
 * two-month-old would state a legal obligation that has not begun.
 */
const PARENT_REPORTS = 'Parents report it to the health unit themselves.';

/**
 * Age-ordered. The order is load-bearing only as a tie-break in match.ts; the bands
 * are what decide who sees what.
 */
export const HEALTH_CHECKPOINTS: readonly HealthCheckpoint[] = [
  {
    id: 'immunization_2_months',
    region: 'ontario',
    minMonths: 2,
    maxMonths: 3,
    annual: false,
    task: "Ontario's routine vaccine schedule has visits at 2 and 4 months.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'immunization_4_months',
    region: 'ontario',
    minMonths: 4,
    maxMonths: 5,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit at 4 months.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'immunization_6_months',
    region: 'ontario',
    minMonths: 6,
    maxMonths: 11,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit at 6 months.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'immunization_12_months',
    region: 'ontario',
    minMonths: 12,
    maxMonths: 14,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit at 1 year.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'immunization_15_months',
    region: 'ontario',
    minMonths: 15,
    maxMonths: 17,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit at 15 months.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'immunization_18_months',
    region: 'ontario',
    minMonths: 18,
    maxMonths: 23,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit at 18 months.",
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_ROUTINE_SCHEDULE,
    sourceUrl: ONTARIO_ROUTINE_SCHEDULE,
    booking: false,
  },
  {
    id: 'well_baby_18_months',
    region: 'ontario',
    minMonths: 18,
    maxMonths: 23,
    annual: false,
    task: 'Ontario runs a longer 18-month well-baby visit with your family doctor.',
    detail: null,
    teenSafeTask: null,
    linkUrl: ONTARIO_18_MONTH_VISIT,
    sourceUrl: ONTARIO_18_MONTH_VISIT,
    booking: true,
  },
  {
    id: 'immunization_4_to_6_years',
    region: 'ontario',
    minMonths: 48,
    maxMonths: 83,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit between ages 4 and 6, before school.",
    detail: PARENT_REPORTS,
    teenSafeTask: null,
    linkUrl: ONTARIO_SCHOOL_VACCINES,
    sourceUrl: ONTARIO_SCHOOL_VACCINES,
    booking: false,
  },
  {
    id: 'dental_school_screening',
    region: 'ontario',
    minMonths: 48,
    maxMonths: 95,
    annual: false,
    task: 'Ontario screens teeth at school in kindergarten and grade 2. Healthy Smiles covers check-ups for families who qualify.',
    detail: 'Enrolling is a form, not a visit.',
    teenSafeTask: null,
    linkUrl: ONTARIO_DENTAL,
    sourceUrl: ONTARIO_DENTAL,
    booking: false,
  },
  {
    id: 'school_records_ispa',
    region: 'toronto',
    minMonths: 48,
    maxMonths: 215,
    // The one recurring row: a record check is worth doing once a school year, and a
    // family who did it last September is not done forever.
    annual: true,
    task: 'Toronto Public Health holds its own copy of student vaccine records, and parents file it on ICON.',
    detail: 'Have the health card number handy.',
    teenSafeTask: 'A student vaccine record check is due on ICON.',
    linkUrl: ICON_PORTAL,
    sourceUrl: TPH_REPORT_STUDENT_VACCINATION,
    booking: false,
  },
  {
    id: 'immunization_grade_7',
    region: 'ontario',
    minMonths: 144,
    // Through 13, not through 12: roughly half a grade-7 cohort turns 13 during the
    // school year, and a band that stopped at the teen boundary would drop exactly
    // those students — the ones whose consent form is already in a backpack. This is
    // the row that makes the teen-safe wording load-bearing rather than decorative.
    maxMonths: 167,
    annual: false,
    task: 'Grade 7 vaccines are given at school in Ontario, and the consent form comes home first.',
    detail: 'Signing and returning it is the whole task.',
    teenSafeTask: 'A school immunization consent form is due.',
    linkUrl: ONTARIO_SCHOOL_VACCINES,
    sourceUrl: ONTARIO_SCHOOL_VACCINES,
    booking: false,
  },
  {
    id: 'immunization_14_to_16_years',
    region: 'ontario',
    minMonths: 168,
    maxMonths: 203,
    annual: false,
    task: "Ontario's routine vaccine schedule has a visit between ages 14 and 16.",
    detail: PARENT_REPORTS,
    teenSafeTask: 'A routine vaccine record check is due between ages 14 and 16.',
    linkUrl: ONTARIO_SCHOOL_VACCINES,
    sourceUrl: ONTARIO_SCHOOL_VACCINES,
    booking: false,
  },
];

const BY_ID = new Map(HEALTH_CHECKPOINTS.map((checkpoint) => [checkpoint.id, checkpoint]));

export function checkpointById(id: string): HealthCheckpoint | null {
  return BY_ID.get(id) ?? null;
}

/**
 * The Ontario school year a moment falls in, named by the calendar year it starts in.
 * September is the boundary because that is when the school record review runs, so a
 * family who filed last October is done for THAT year and open again the next.
 *
 * Read in the RUNTIME's zone rather than the family's, and that is safe rather than
 * sloppy: the only caller is the nudge sweep, which acts on a family exclusively in
 * their local mid-morning slot. Every Canadian zone is behind UTC, so a 10 a.m. local
 * instant lands on the same calendar day in UTC — the Aug-31/Sep-1 turnover can never
 * be straddled. A caller that ran at local midnight would need the family's zone.
 */
export function schoolYearOf(now: Date): number {
  const SEPTEMBER = 8;
  return now.getMonth() >= SEPTEMBER ? now.getFullYear() : now.getFullYear() - 1;
}

/**
 * Which run of a checkpoint is current. One-time rows are always 0, so the identity
 * below is uniform and callers never branch on recurrence.
 */
export function checkpointOccurrence(checkpoint: HealthCheckpoint, now: Date): number {
  return checkpoint.annual ? schoolYearOf(now) : 0;
}

/** Stands in for the child id on a HOUSEHOLD-scoped checkpoint. */
export const HOUSEHOLD_CHILD_TOKEN = '*';

/**
 * A checkpoint's natural identity: the thing every surface's told-marker keys on
 * (lib/health/told.ts), and the thing a "done" reply suppresses. One primitive, two
 * consumers — a marker key and a memory fact key built from different strings would
 * drift the first time either side changed, and a family would be nudged about
 * paperwork they told us was filed.
 *
 * The SCOPE differs by recurrence, and that difference is the whole point:
 *
 *   - a ONE-TIME checkpoint is per CHILD, because two siblings reach the six-month
 *     visit years apart and each deserves their own reminder;
 *   - an ANNUAL checkpoint is per HOUSEHOLD and per school year, because it is one
 *     errand a parent does in one sitting for every child the message named. Keying it
 *     per child would re-ask about a sibling the following week, which is exactly the
 *     nagging this feature exists to remove.
 */
export function checkpointRef(
  checkpoint: HealthCheckpoint,
  childId: string,
  occurrence: number,
): string {
  const scope = checkpoint.annual ? HOUSEHOLD_CHILD_TOKEN : childId;
  return `${checkpoint.id}:${scope}:${occurrence}`;
}

/**
 * The inverse of {@link checkpointRef}; null when the string is not one, or names a
 * checkpoint this build no longer ships. `childId` comes back null for a
 * household-scoped ref — there is no one child it belongs to, and callers that write it
 * to a nullable column want exactly that.
 */
export function parseCheckpointRef(
  ref: string,
): { checkpointId: string; childId: string | null; occurrence: number } | null {
  const parts = ref.split(':');
  if (parts.length !== 3) return null;
  const [checkpointId, scope, rawOccurrence] = parts as [string, string, string];
  if (!BY_ID.has(checkpointId) || scope.length === 0) return null;
  if (!/^\d+$/.test(rawOccurrence)) return null;
  return {
    checkpointId,
    childId: scope === HOUSEHOLD_CHILD_TOKEN ? null : scope,
    occurrence: Number(rawOccurrence),
  };
}
