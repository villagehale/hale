/**
 * F1 — Child Development & Wellbeing Companion (0–18). Deterministic, curated
 * guidance keyed by age and stage. NO LLM here — this is hand-maintained data
 * plus pure functions, so web and worker compute the same companion view from a
 * child's date of birth alone.
 *
 * Rule #1: everything here is SUPPORTIVE, never diagnostic. Health and milestone
 * entries each carry a "confirm with your provider" note; milestone framing is
 * "most kids by X — if not, worth asking", never a pass/fail. This is general
 * guidance a parent reads alongside (not instead of) their care provider.
 */
import { ageInMonths, type FamilyStage, stageFromAgeInMonths } from './stage.js';

/** Standing reminder attached to every health and milestone item (rule #1). */
export const CONFIRM_WITH_PROVIDER =
  'General guidance — confirm timing and details with your provider or local public health.';

/**
 * Canadian routine schedule, curated from the publicly documented Canadian
 * immunization and well-child (Rourke Baby Record / periodic health visit)
 * cadence: immunizations at 2, 4, 6, 12, 15, and 18 months and again at 4–6
 * years; well-child visits at 1–2 weeks, 2, 4, 6, 9, 12, 15, and 18 months,
 * then periodic visits through childhood. Provinces vary in exact products and
 * timing — hence the confirm-with-provider note on every entry. This is
 * GUIDANCE data, not a medical record.
 */
export interface HealthItem {
  /** Age in completed months the item is scheduled for. */
  ageMonths: number;
  kind: 'immunization' | 'well_child_visit';
  /** Parent-facing label, e.g. "4-month immunizations". */
  what: string;
  note: string;
}

const HEALTH_TIMELINE: readonly HealthItem[] = [
  { ageMonths: 0, kind: 'well_child_visit', what: 'Newborn / 1–2 week check' },
  { ageMonths: 2, kind: 'well_child_visit', what: '2-month well-baby visit' },
  { ageMonths: 2, kind: 'immunization', what: '2-month immunizations' },
  { ageMonths: 4, kind: 'well_child_visit', what: '4-month well-baby visit' },
  { ageMonths: 4, kind: 'immunization', what: '4-month immunizations' },
  { ageMonths: 6, kind: 'well_child_visit', what: '6-month well-baby visit' },
  { ageMonths: 6, kind: 'immunization', what: '6-month immunizations' },
  { ageMonths: 9, kind: 'well_child_visit', what: '9-month well-baby visit' },
  { ageMonths: 12, kind: 'well_child_visit', what: '12-month well-baby visit' },
  { ageMonths: 12, kind: 'immunization', what: '12-month immunizations' },
  { ageMonths: 15, kind: 'well_child_visit', what: '15-month well-baby visit' },
  { ageMonths: 15, kind: 'immunization', what: '15-month immunizations' },
  { ageMonths: 18, kind: 'well_child_visit', what: '18-month well-baby visit' },
  { ageMonths: 18, kind: 'immunization', what: '18-month immunizations' },
  { ageMonths: 60, kind: 'immunization', what: '4–6 year (pre-school) immunizations' },
  { ageMonths: 60, kind: 'well_child_visit', what: '4–6 year well-child visit' },
  { ageMonths: 144, kind: 'immunization', what: 'Grade-7 / pre-teen immunizations' },
  { ageMonths: 144, kind: 'well_child_visit', what: 'Pre-teen periodic health visit' },
].map((item) => ({ ...item, note: CONFIRM_WITH_PROVIDER }) as HealthItem);

/**
 * A developmental or learning milestone for a stage, with the typical age window
 * in completed months. Framing is non-diagnostic: a child outside the window is
 * "worth asking about", never "delayed".
 */
export interface Milestone {
  area: 'motor' | 'language' | 'social' | 'cognitive' | 'independence';
  /** What most children do, e.g. "Rolls over". */
  what: string;
  /** Typical window, in completed months, [from, to]. */
  typicalWindowMonths: readonly [number, number];
  note: string;
}

const MILESTONES_BY_STAGE: Record<FamilyStage, readonly Milestone[]> = {
  newborn: [
    { area: 'social', what: 'First social smile', typicalWindowMonths: [1, 3], note: CONFIRM_WITH_PROVIDER },
    { area: 'motor', what: 'Holds head steady when upright', typicalWindowMonths: [2, 4], note: CONFIRM_WITH_PROVIDER },
    { area: 'motor', what: 'Rolls over', typicalWindowMonths: [4, 6], note: CONFIRM_WITH_PROVIDER },
    { area: 'motor', what: 'Sits without support', typicalWindowMonths: [6, 9], note: CONFIRM_WITH_PROVIDER },
    { area: 'language', what: 'Babbles and responds to sounds', typicalWindowMonths: [4, 9], note: CONFIRM_WITH_PROVIDER },
  ],
  toddler: [
    { area: 'motor', what: 'Walks independently', typicalWindowMonths: [12, 18], note: CONFIRM_WITH_PROVIDER },
    { area: 'language', what: 'Says first words', typicalWindowMonths: [12, 18], note: CONFIRM_WITH_PROVIDER },
    { area: 'language', what: 'Combines two words', typicalWindowMonths: [18, 30], note: CONFIRM_WITH_PROVIDER },
    { area: 'social', what: 'Plays alongside other children', typicalWindowMonths: [24, 36], note: CONFIRM_WITH_PROVIDER },
    { area: 'independence', what: 'Shows interest in potty training', typicalWindowMonths: [24, 42], note: CONFIRM_WITH_PROVIDER },
  ],
  child: [
    { area: 'cognitive', what: 'Begins reading simple words', typicalWindowMonths: [60, 84], note: CONFIRM_WITH_PROVIDER },
    { area: 'motor', what: 'Rides a bike without training wheels', typicalWindowMonths: [60, 96], note: CONFIRM_WITH_PROVIDER },
    { area: 'social', what: 'Forms close friendships', typicalWindowMonths: [60, 120], note: CONFIRM_WITH_PROVIDER },
    { area: 'cognitive', what: 'Manages homework with some support', typicalWindowMonths: [84, 144], note: CONFIRM_WITH_PROVIDER },
  ],
  teenager: [
    { area: 'independence', what: 'Takes responsibility for schoolwork', typicalWindowMonths: [156, 180], note: CONFIRM_WITH_PROVIDER },
    { area: 'social', what: 'Builds identity through peer relationships', typicalWindowMonths: [156, 192], note: CONFIRM_WITH_PROVIDER },
    { area: 'independence', what: 'Begins managing money and time', typicalWindowMonths: [168, 204], note: CONFIRM_WITH_PROVIDER },
    { area: 'cognitive', what: 'Plans for life after secondary school', typicalWindowMonths: [192, 216], note: CONFIRM_WITH_PROVIDER },
  ],
};

/** Curated "what matters now / what's next" guidance for a stage. */
export interface StageGuidance {
  whatsNow: readonly string[];
  /** The upcoming stage transition and a short note about it. */
  whatsNext: string;
}

const GUIDANCE_BY_STAGE: Record<FamilyStage, StageGuidance> = {
  newborn: {
    whatsNow: [
      'Feeding and sleep rhythms are the whole job right now — follow your baby’s cues.',
      'Tummy time while awake builds the neck and shoulder strength for rolling and sitting.',
      'Talk, sing, and respond to coos — early back-and-forth is how language starts.',
    ],
    whatsNext:
      'Around the first birthday, your baby moves into the toddler stage — expect first steps and first words.',
  },
  toddler: {
    whatsNow: [
      'Language is taking off — narrate your day and read together daily.',
      'Watch for readiness signs before starting potty training; there’s no fixed deadline.',
      'Consistent routines and gentle limits help big toddler feelings feel safe.',
    ],
    whatsNext:
      'By around age four, your child enters the school-age stage — friendships and early learning come to the fore.',
  },
  child: {
    whatsNow: [
      'School and friendships shape these years — stay curious about both.',
      'Set predictable screen-time boundaries that fit your family.',
      'Daily physical activity and steady sleep support focus and mood.',
    ],
    whatsNext:
      'Around age thirteen, your child becomes a teenager — independence and privacy grow, and your role shifts to coach.',
  },
  teenager: {
    whatsNow: [
      'Independence grows — offer guidance while letting them own more decisions.',
      'Keep checking in on wellbeing and mental health, not just academics.',
      'Privacy matters now; lead with trust and open conversation.',
    ],
    whatsNext:
      'As your teen approaches eighteen, the focus turns to life after secondary school and adult independence.',
  },
};

/** A milestone annotated with where the child sits relative to its window. */
export interface MilestoneStatus extends Milestone {
  /** Before the window, inside it, or past the typical upper bound. */
  timing: 'upcoming' | 'in_window' | 'watch';
}

/** A health item annotated with how soon it is due relative to the child's age. */
export interface UpcomingHealthItem extends HealthItem {
  /**
   * Whole weeks until the item is due. Negative when the scheduled age has
   * passed; ~0 when due about now. Computed from completed-month age, so it is a
   * coarse planning signal, not a precise countdown.
   */
  dueInWeeks: number;
}

export interface CompanionView {
  stage: FamilyStage;
  ageMonths: number;
  /** Name echoed back when provided, for personalized copy. */
  name: string | null;
  /** Health items at or after the child's current age, soonest first. */
  nextHealth: readonly UpcomingHealthItem[];
  milestones: readonly MilestoneStatus[];
  whatsNow: readonly string[];
  whatsNext: string;
}

const WEEKS_PER_MONTH = 4.345;

function classifyMilestone(milestone: Milestone, ageMonths: number): MilestoneStatus['timing'] {
  const [from, to] = milestone.typicalWindowMonths;
  if (ageMonths < from) return 'upcoming';
  if (ageMonths <= to) return 'in_window';
  return 'watch';
}

/**
 * The companion view for one child, derived purely from date of birth. No I/O,
 * deterministic given `now`. Health items already passed are dropped; the rest
 * are returned soonest-first with a coarse weeks-until estimate. Milestones are
 * the child's current stage, each tagged with where they sit in the typical
 * window (rule #1: "watch" means worth asking, never "delayed").
 */
export function companionForChild(
  child: { dateOfBirth: string | Date; name?: string | null },
  now: Date = new Date(),
): CompanionView {
  const months = ageInMonths(child.dateOfBirth, now);
  const stage = stageFromAgeInMonths(months);

  const nextHealth = HEALTH_TIMELINE.filter((item) => item.ageMonths >= months)
    .map((item) => ({
      ...item,
      dueInWeeks: Math.round((item.ageMonths - months) * WEEKS_PER_MONTH),
    }))
    .sort((a, b) => a.ageMonths - b.ageMonths);

  const milestones = MILESTONES_BY_STAGE[stage].map((milestone) => ({
    ...milestone,
    timing: classifyMilestone(milestone, months),
  }));

  const guidance = GUIDANCE_BY_STAGE[stage];

  return {
    stage,
    ageMonths: months,
    name: child.name ?? null,
    nextHealth,
    milestones,
    whatsNow: guidance.whatsNow,
    whatsNext: guidance.whatsNext,
  };
}
