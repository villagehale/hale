import type { ActionType, FamilyStage } from '@hearth/types';

/**
 * Rule #4 autonomy gates, as pure functions. The orchestrator gates autonomous
 * EXECUTION on confidence + plan tier (fix-wave A / B18); these add the two
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
