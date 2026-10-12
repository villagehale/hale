import type { ActionType, FamilyStage } from '@hale/types';

/**
 * Rule #4 autonomy gates, as pure functions. The orchestrator gates autonomous
 * EXECUTION on confidence (fix-wave A); these add the two
 * missing structural gates the hard rule names: the 7-day observe window and the
 * per-action-type 5-streak. Data (families.createdAt, action history) is supplied
 * by injected db lookups in memory-writer — these functions do no I/O.
 */

/** New families observe-only for their first 7 days (hard rule #4). */
export const OBSERVATION_WINDOW_DAYS = 7;

/** Consecutive human-approved completions of an action type needed for L3 (hard rule #4). */
export const AUTONOMY_STREAK_REQUIRED = 5;

/**
 * One row of an action type's recent approval history, most-recent-first.
 * `humanApproved` is the derived "human-approved completion" flag (see
 * loadActionApprovalHistory in memory-writer for the exact schema derivation).
 */
export interface ActionApprovalRecord {
  actionType: string;
  humanApproved: boolean;
}

/**
 * True while a family is still inside its 7-day observe window — autonomy is
 * dark for the whole window. The window is `< 7 days` old: a family created
 * exactly 7 days ago has cleared it. Future createdAt (clock skew) reads as
 * in-window (age 0), the conservative direction.
 */
export function withinObservationWindow(createdAt: Date, now: Date = new Date()): boolean {
  const ageMs = now.getTime() - createdAt.getTime();
  return ageMs < OBSERVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * True iff the family has ≥5 consecutive most-recent human-approved completions
 * of `actionType`. `history` is most-recent-first; only rows of the target type
 * are considered, and the first non-approved row of that type breaks the run.
 * A rejection inside the run resets the streak; with zero history the streak is
 * 0 → autonomy stays dark (the correct default for a new action type).
 */
export function streakSatisfiesAutonomy(
  actionType: ActionType,
  history: ActionApprovalRecord[],
): boolean {
  let streak = 0;
  for (const record of history) {
    if (record.actionType !== actionType) continue;
    if (!record.humanApproved) break;
    streak += 1;
    if (streak >= AUTONOMY_STREAK_REQUIRED) return true;
  }
  return false;
}

/**
 * Whether Hale may EVER do an action kind on its own (Barton, 2026-10-11). Booking,
 * registration and paying are denied in code, not merely unwired, so wiring one of
 * their executors later can never make it autonomous; a human approval still executes
 * a denied kind. `satisfies Record<ActionType, …>` makes a new ActionType a compile
 * error until it is classified here.
 */
const AUTONOMY_BY_KIND = {
  send_email: 'allowed',
  reply_to_email: 'allowed',
  create_calendar_event: 'allowed',
  update_calendar_event: 'allowed',
  place_supply_order: 'denied',
  cancel_supply_order: 'denied',
  fill_pdf_form: 'denied',
  submit_government_form: 'denied',
  book_clinic_portal: 'denied',
  cancel_clinic_appointment: 'denied',
  share_photos_with_family: 'allowed',
  add_to_digest_only: 'allowed',
  add_to_routine: 'allowed',
  calendar_add: 'allowed',
  calendar_move: 'allowed',
  calendar_cancel: 'allowed',
} as const satisfies Record<ActionType, 'allowed' | 'denied'>;

export function autonomyDeniedForKind(actionType: ActionType): boolean {
  return AUTONOMY_BY_KIND[actionType] === 'denied';
}

/** The kinds Hale may do on its own once a parent opts in: the ones a parent can switch off. */
export const AUTONOMY_ALLOWED_KINDS = (Object.keys(AUTONOMY_BY_KIND) as ActionType[]).filter(
  (kind) => AUTONOMY_BY_KIND[kind] === 'allowed',
);

/**
 * True iff the teen-redaction structural cap must fire: the family has at least
 * one teenager AND the classifier marked the event teen-content. When it fires,
 * routing is HARD-CAPPED at surface_only/drafted_for_approval regardless of the
 * model's suggestion (rule #1 structural enforcement of the teenager pack's
 * redaction rule — never trust prompt adherence alone). Pure — no I/O.
 *
 * Stage-wiring TODO (same as B17 / classifier.ts): until the orchestrator looks
 * up children + dateOfBirth, `stages` defaults to ['newborn'], so this never
 * fires in production yet — the cap is dormant, not absent.
 */
export function teenRedactionCapApplies(stages: FamilyStage[], teenContent: boolean): boolean {
  return teenContent && stages.includes('teenager');
}
