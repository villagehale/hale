/**
 * Typed placeholder content for Companion surfaces the prototype shows but which have
 * NO honest backend semantics yet (Global Constraint 6: stub-data lives here, typed,
 * never invented inline). Every export is a documented substitution — replace each
 * with a real source before treating it as truth. See task-7-report.md.
 */

/**
 * The Growth "overview" verdict + reference line (Growth tab). STUB: Hale does NOT
 * compute WHO percentiles — there is deliberately no server-side growth derivation
 * (a plain record of readings, not a clinical assessment). These are the prototype's
 * placeholder labels; the accompanying caveat copy keeps the screen honest until a
 * real percentile computation exists. Do not treat "On track" as a clinical verdict.
 */
export const GROWTH_VERDICT = 'On track' as const;
export const GROWTH_DATA_SOURCE = 'WHO Growth Standards' as const;

/** One row of the suggested daily rhythm (Routines → Daily). */
export interface SuggestedRoutineRow {
  /** Local clock label, e.g. "7:00 AM". */
  time: string;
  label: string;
}

/**
 * A suggested daily rhythm (Routines → Daily). STUB: there is no per-child daily
 * routine backend — nothing here is tailored to the child or tracked. Rendered as an
 * illustrative starting point with an explicit "not tracked yet" note; the real,
 * honest routine (Hale's weekly proposal) lives under the Weekly pill. Mirrors the
 * prototype's example toddler day.
 */
export const SUGGESTED_DAILY_ROUTINE: readonly SuggestedRoutineRow[] = [
  { time: '7:00 AM', label: 'Wake up' },
  { time: '7:30 AM', label: 'Breakfast' },
  { time: '9:00 AM', label: 'Play time' },
  { time: '10:30 AM', label: 'Nap' },
  { time: '12:30 PM', label: 'Lunch' },
  { time: '3:00 PM', label: 'Snack' },
  { time: '6:00 PM', label: 'Dinner' },
  { time: '7:30 PM', label: 'Bedtime' },
];

/** A childcare provider's live-capacity status — the prototype's Accepting / Waitlist
 * badge. This is the ONE datum Hale has no source for yet (there is no childcare
 * capacity backend), so it is stubbed here and disclosed in the UI. */
export type ChildcareStatus = 'accepting' | 'waitlist';

export interface StubChildcareProvider {
  name: string;
  /** "Licensed centre" / "Home care" — the provider kind, illustrative. */
  kind: string;
  status: ChildcareStatus;
}

/**
 * Sample childcare listings for the Village tab. STUB: Hale has no childcare directory
 * or live-capacity feed yet, so these providers and their Accepting/Waitlist status are
 * illustrative — NOT real availability. Rendered under an explicit "sample listings"
 * caveat so no parent mistakes them for verified openings. Deliberately carries NO
 * fabricated distances / ratings / review counts (DATA HONESTY: no invented numbers).
 * Replace with a real provider source before treating any of this as truth.
 */
export const STUB_CHILDCARE: readonly StubChildcareProvider[] = [
  { name: 'Bright Steps Daycare', kind: 'Licensed centre', status: 'accepting' },
  { name: 'Little Explorers Home Care', kind: 'Home care', status: 'waitlist' },
  { name: 'KidsTown Early Learning', kind: 'Licensed centre', status: 'accepting' },
];

/** One vaccine on the sample immunization record (Immunizations page → Record card). */
export interface StubImmunizationEntry {
  /** Vaccine abbreviation as it appears on a Canadian immunization record. */
  vaccine: string;
  /** What the vaccine protects against — stable, general reference (not per-child). */
  protects: string;
}

/**
 * A SAMPLE immunization record for the Immunizations page. STUB: Hale has no
 * per-child immunization-record store yet, so this is an ILLUSTRATIVE list of the
 * routine early-childhood vaccines (the prototype's five) — NOT any child's actual
 * record. It deliberately carries NO administration dates: a fabricated "given on"
 * date presented as this child's record would be dishonest (DATA HONESTY, and the
 * task's explicit "do not invent a fake per-child record" rule). Rendered under an
 * explicit "sample record" disclosure pointing parents to Documents for the real one.
 */
export const STUB_IMMUNIZATION_RECORD: readonly StubImmunizationEntry[] = [
  { vaccine: 'Hep B', protects: 'Hepatitis B' },
  { vaccine: 'DTaP', protects: 'Diphtheria, tetanus & pertussis' },
  { vaccine: 'Hib', protects: 'Haemophilus influenzae type b' },
  { vaccine: 'PCV-13', protects: 'Pneumococcal disease' },
  { vaccine: 'IPV', protects: 'Polio' },
];

/** One program row on the Government Benefits page. */
export interface StubBenefitProgram {
  name: string;
  /** The program's amount / eligibility summary, e.g. "Up to $7,787 / child / year". */
  detail: string;
  /** Which government runs it — "Federal" | "Ontario". Factual per program (CCB is
   * federal, OCB/subsidy are Ontario), NOT derived from the family's actual province. */
  jurisdiction: string;
}

/**
 * The Government Benefits programs (prototype's three rows). STUB: Hale does NOT
 * check eligibility or personalize these to a family — they are a general reference
 * to well-known Canadian child-benefit programs, disclosed as such, with the real
 * action being "Ask Hale about eligibility". Amounts are the program's published
 * maximums framing ("up to …"), which change each benefit year — surfaced with a
 * "check the official program for current amounts" caveat so no figure reads as a
 * personalized entitlement. Replace with a real, location-aware programs source
 * before treating any of this as tailored advice.
 */
export const STUB_BENEFITS: readonly StubBenefitProgram[] = [
  { name: 'Canada Child Benefit', detail: 'Up to $7,787 / child / year', jurisdiction: 'Federal' },
  { name: 'Ontario Child Benefit', detail: 'Up to $1,607 / child / year', jurisdiction: 'Ontario' },
  { name: 'Child Care Fee Subsidy', detail: 'Based on family income', jurisdiction: 'Ontario' },
];
