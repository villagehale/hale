import type { ActionType } from '@hale/types';

/**
 * VIL-719 · the three-tier ask policy. For every kind of action Hale takes, code decides
 * whether Hale just does it, does it and tells the parent after, or asks first. The decision
 * reads the action's classes and structured facts, never the parent's words. The tables are
 * written out for people in docs/ask-policy.md, and a test holds that doc to this file.
 *
 * A tier never loosens an autonomy gate (CLAUDE.md rule #4). Whether Hale may START a kind on
 * its own is still decided by the 7-day observe window, the per-parent 5-streak and the
 * opt-in, in the orchestrator. The tier decides two things on top of that: an ask-first
 * action runs only on the parent's recorded yes, whatever the streak says, and a tell-after
 * action is followed by a text the model writes. Pure: no I/O, no flag read.
 */

/** Ordered from least to most asking; {@link strictestAskTier} reads the order. */
export const ASK_TIERS = ['just_do', 'tell_after', 'ask_first'] as const;
export type AskTier = (typeof ASK_TIERS)[number];

/** What an action does, in the terms the policy is written in. */
export const ACTION_CLASSES = [
  /** Reads the family's own data or a public page. */
  'read',
  /** Writes only Hale's own notes about this family: memory, the digest, the routine. */
  'remember',
  /** Adds, moves or cancels an item on this family's own calendar. */
  'family_calendar',
  /** Prepares something the parent sends themselves; nothing leaves on Hale's word. */
  'parent_draft',
  /** Moves money, or can incur a fee. */
  'spend_money',
  /** Registers a child, enrols the family, or books or cancels an appointment. */
  'register_or_book',
  /** Sends something to a person or organisation outside the family's own parents. */
  'contact_third_party',
  /** Reads, shares or changes another person's information. */
  'other_persons_info',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Every class has exactly one tier. */
export const ASK_TIER_BY_CLASS = {
  read: 'just_do',
  remember: 'just_do',
  family_calendar: 'tell_after',
  parent_draft: 'tell_after',
  spend_money: 'ask_first',
  register_or_book: 'ask_first',
  contact_third_party: 'ask_first',
  other_persons_info: 'ask_first',
} as const satisfies Record<ActionClass, AskTier>;

type Classes = readonly [ActionClass, ...ActionClass[]];

/**
 * The classes of every action kind the executor knows. An action takes the strictest tier of
 * its classes. `satisfies Record<ActionType, …>` makes a new ActionType a compile error until
 * it is classified here. The money classes match the kinds whose REQUIRED_CHECKS include
 * check_spending_cap, every kind with a recipient allowlist contacts a third party, and every
 * cross-parent kind touches another person's information; tests hold all three.
 */
export const ACTION_CLASSES_BY_KIND = {
  // Mail on the parent's behalf goes to someone outside the family.
  send_email: ['contact_third_party'],
  reply_to_email: ['contact_third_party'],
  // The shared Google calendar commits the co-parent's schedule (CROSS_PARENT_ACTION_TYPES).
  create_calendar_event: ['family_calendar', 'other_persons_info'],
  update_calendar_event: ['family_calendar', 'other_persons_info'],
  // A merchant order, or a cancellation that can carry a fee.
  place_supply_order: ['spend_money', 'contact_third_party'],
  cancel_supply_order: ['spend_money', 'contact_third_party'],
  // A child's personal details written into a form.
  fill_pdf_form: ['other_persons_info'],
  // A government submission: may carry a fee, goes to an agency, carries a child's details.
  submit_government_form: ['spend_money', 'contact_third_party', 'other_persons_info'],
  // A clinic booking: may carry a fee, commits the family, goes to the clinic.
  book_clinic_portal: ['spend_money', 'register_or_book', 'contact_third_party'],
  cancel_clinic_appointment: ['register_or_book', 'contact_third_party'],
  // A child's image sent outward.
  share_photos_with_family: ['contact_third_party', 'other_persons_info'],
  // Hale's own family_plans notes.
  add_to_digest_only: ['remember'],
  add_to_routine: ['remember'],
  // Hale's own family calendar (family_events), visible to both parents.
  calendar_add: ['family_calendar'],
  calendar_move: ['family_calendar'],
  calendar_cancel: ['family_calendar'],
} as const satisfies Record<ActionType, Classes>;

/**
 * Structured facts that can only ADD classes, so a fact can raise a tier and never lower it.
 * None is read from words by this code: each comes from a field other code already set.
 * Teen content is not one: the teen cap holds a teenager's private content before the
 * policy is read (docs/ask-policy.md).
 */
export interface AskFacts {
  /**
   * The drafter's stored reading that the action commits the family to an enrolment, a
   * booking or a payment. Adds `register_or_book`.
   */
  commitsFamily?: boolean;
  /**
   * On a pass with no approving parent, a calendar kind's Google leg would write to a calendar
   * whose owner holds no live grant for the kind. Adds `other_persons_info`.
   */
  writesAnotherParentsCalendar?: boolean;
}

/** True when `value` is a kind this policy classifies. */
export function isAskPolicyKind(value: string): value is ActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_CLASSES_BY_KIND, value);
}

/**
 * The classes of one action, in {@link ACTION_CLASSES} order, without repeats. A kind the
 * table does not know yields no class at all, which {@link askTierFor} reads as ask first.
 */
export function actionClassesFor(kind: ActionType, facts: AskFacts = {}): ActionClass[] {
  if (!isAskPolicyKind(kind)) return [];
  const classes = new Set<ActionClass>(ACTION_CLASSES_BY_KIND[kind]);
  if (facts.commitsFamily === true) classes.add('register_or_book');
  if (facts.writesAnotherParentsCalendar === true) classes.add('other_persons_info');
  return ACTION_CLASSES.filter((actionClass) => classes.has(actionClass));
}

/** The most asking of `tiers`; just do when there are none. */
export function strictestAskTier(tiers: Iterable<AskTier>): AskTier {
  let rank = 0;
  for (const tier of tiers) rank = Math.max(rank, ASK_TIERS.indexOf(tier));
  return ASK_TIERS[rank] ?? 'ask_first';
}

/**
 * The tier of one action: the strictest tier of its classes. Fails closed: a kind with no
 * class (one this table does not know, read from a text column) is ask first.
 */
export function askTierFor(kind: ActionType, facts: AskFacts = {}): AskTier {
  const classes = actionClassesFor(kind, facts);
  if (classes.length === 0) return 'ask_first';
  return strictestAskTier(classes.map((actionClass) => ASK_TIER_BY_CLASS[actionClass]));
}
