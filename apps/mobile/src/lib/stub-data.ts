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

/** One editorial guide (Resources → Guide page). */
export interface GuideContent {
  /** URL id — the `/guide/[id]` segment the Resources rows route to. */
  id: string;
  /** Serif page title, e.g. "Sleep & settling". */
  title: string;
  /** Honest reading-time estimate, e.g. "4 min read". */
  readTime: string;
  intro: string;
  /** Ordered tips rendered as a numbered card. */
  tips: readonly string[];
}

/**
 * The Resources guide library. NOT a stub for a missing backend: these are genuine,
 * static editorial articles written for the app — static copy IS the honest, correct
 * representation of editorial content (there is no per-family "guide feed" this stands
 * in for). General parenting guidance for a Canadian audience; it deliberately carries
 * NO medical dosing or diagnosis — every health cue is framed as "when to seek care",
 * and each guide points parents back to their own provider, 811, or 911.
 *
 * Attribution is honest: the Guide page meta reads "From Hale's guide library", NOT the
 * prototype's "Reviewed by Hale's care team" — Hale has no clinical care-team review
 * process, so that claim would be false (see task-14-report.md).
 *
 * These three are the guides reachable from the Resources list. (The prototype also
 * sketches a 4th, rainy-day "indoor places", but only from a hardcoded Saved-list mock;
 * the real Saved screen is village-candidate data with no guide rows, so shipping that
 * guide would be an unreachable dead route — omitted per Simplicity First.)
 */
export const GUIDES: readonly GuideContent[] = [
  {
    id: 'sleep',
    title: 'Sleep & settling',
    readTime: '4 min read',
    intro:
      'Gentle, age-appropriate ways to help your child settle — and what to expect as sleep changes from the newborn months through toddlerhood. Every child is different, so treat these as starting points rather than rules.',
    tips: [
      'Keep a short, consistent wind-down — the same few steps in the same order every night. Predictability signals sleep more reliably than any single technique.',
      'Watch wake windows rather than the clock. An overtired child is harder to settle, so catching early sleepy cues — yawning, looking away, fussing — makes bedtime smoother.',
      'When you can, put your baby down drowsy but awake so they practise settling themselves. Follow safe-sleep basics: on the back, on a firm flat surface, with nothing loose in the crib.',
      'Expect brief regressions around 4, 12, and 18 months, often tied to a developmental leap or teething. Hold your routine steady — most pass within a week or two.',
    ],
  },
  {
    id: 'solids',
    title: 'Starting solids',
    readTime: '5 min read',
    intro:
      'Most babies are ready for first foods around 6 months, once they can sit with support and show interest in eating. Here is how to start simply and safely. If your baby was born early or has a health condition, check timing with your provider first.',
    tips: [
      'Offer iron-rich foods first — iron-fortified infant cereal, well-cooked lentils or beans, and finely minced meat. Iron stores run low around 6 months, so these matter most.',
      'Introduce common allergens (such as peanut and egg) early and one at a time, then keep offering them regularly. If there is a strong family history of allergy, talk to your provider before you start.',
      'Let your child set the pace — appetite varies a lot day to day. Food alongside breast milk or formula is about learning and exploring at this stage, not hitting a quota.',
      'Lower choking risk: no whole nuts, popcorn, or hard raw chunks. Cut round foods like grapes lengthwise, and always stay with your baby while they eat.',
    ],
  },
  {
    id: 'firstaid',
    title: 'First aid basics',
    readTime: '6 min read',
    intro:
      'A calm, quick reference for common moments — and, just as important, when to reach for help. This is general guidance, not medical advice: when in doubt, call your provider or your provincial health line (811 in most provinces), and call 911 for an emergency.',
    tips: [
      'A fever over 38°C in a baby under 3 months is always a reason to call your provider or 811 right away, even if your baby seems otherwise well.',
      'For a minor burn, cool it under cool running water for 10–20 minutes — no ice, butter, or creams. Cover loosely with a clean, non-stick dressing and seek care for anything larger than the palm of the hand.',
      'Call 911 immediately for trouble breathing, choking that does not clear, a seizure, a stiff neck with fever, or if your child is hard to wake. Trust your instinct — you know your child best.',
      'Keep emergency numbers and your poison-control line where a caregiver can find them fast, and save them in Hale so they are always a tap away.',
    ],
  },
];

/** Look up an editorial guide by its `/guide/[id]` segment; undefined for an unknown
 * id (e.g. a malformed deep link), which the Guide page renders as a not-found state. */
export function findGuide(id: string): GuideContent | undefined {
  return GUIDES.find((guide) => guide.id === id);
}
