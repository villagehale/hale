/**
 * Parent-facing lines for duty asks.
 *
 * Eng does not write these. Sloane (Head of Design) replaces each TODO-Design
 * placeholder. French twins are ASCII. Shadow mode does not send them.
 * VIL-382 may send only when the duty-sends flag is on AND
 * {@link dutyCopyLocked} is exactly `true` AND the line no longer contains
 * `TODO-Design`. A locked flag with the placeholder still in place does not
 * send.
 */

export const COPARENT_DUTY_COPY_LOCKED_ENV = 'COPARENT_DUTY_COPY_LOCKED';

/** Strict `true`. `TRUE` and `true\n` stay unlocked. */
export function dutyCopyLocked(): boolean {
  return process.env[COPARENT_DUTY_COPY_LOCKED_ENV] === 'true';
}

export const DUTY_WHICH_KID_COPY = 'TODO-Design: which kid?';
export const DUTY_WHICH_KID_COPY_FR = 'TODO-Design: quel enfant';

export const DUTY_BOTH_CLAIMED_COPY = 'TODO-Design: both parents said they will do this';
export const DUTY_BOTH_CLAIMED_COPY_FR = 'TODO-Design: les deux parents ont dit oui';

export const DUTY_WEEK_OVERVIEW_COPY_EN = 'TODO-Design: who is on what this week';
export const DUTY_WEEK_OVERVIEW_COPY_FR = 'TODO-Design: qui fait quoi cette semaine';

export const DUTY_REASK_COPY_EN = 'TODO-Design: still no owner';
export const DUTY_REASK_COPY_FR = 'TODO-Design: toujours personne';

export const DUTY_NIGHT_BEFORE_COPY_EN = 'TODO-Design: confirm tomorrow';
export const DUTY_NIGHT_BEFORE_COPY_FR = 'TODO-Design: confirmer demain';

export const DUTY_PARENT_ASK_COPY_EN = 'TODO-Design: who has this duty';
export const DUTY_PARENT_ASK_COPY_FR = 'TODO-Design: qui a cette tache';

export const DUTY_SILENT_PARENT_COPY_EN = 'TODO-Design: name the quiet parent once';
export const DUTY_SILENT_PARENT_COPY_FR = 'TODO-Design: nommer le parent silencieux une fois';

export const DUTY_PLACEHOLDER_STRINGS = [
  DUTY_WHICH_KID_COPY,
  DUTY_WHICH_KID_COPY_FR,
  DUTY_BOTH_CLAIMED_COPY,
  DUTY_BOTH_CLAIMED_COPY_FR,
  DUTY_WEEK_OVERVIEW_COPY_EN,
  DUTY_WEEK_OVERVIEW_COPY_FR,
  DUTY_REASK_COPY_EN,
  DUTY_REASK_COPY_FR,
  DUTY_NIGHT_BEFORE_COPY_EN,
  DUTY_NIGHT_BEFORE_COPY_FR,
  DUTY_PARENT_ASK_COPY_EN,
  DUTY_PARENT_ASK_COPY_FR,
  DUTY_SILENT_PARENT_COPY_EN,
  DUTY_SILENT_PARENT_COPY_FR,
] as const;

export type DutyCopyId =
  | 'week_overview'
  | 'reask_48h'
  | 'night_before'
  | 'parent_initiated'
  | 'which_kid'
  | 'both_claimed'
  | 'silent_parent';

const DUTY_COPY_TABLE: Record<DutyCopyId, { en: string; fr: string }> = {
  week_overview: { en: DUTY_WEEK_OVERVIEW_COPY_EN, fr: DUTY_WEEK_OVERVIEW_COPY_FR },
  reask_48h: { en: DUTY_REASK_COPY_EN, fr: DUTY_REASK_COPY_FR },
  night_before: { en: DUTY_NIGHT_BEFORE_COPY_EN, fr: DUTY_NIGHT_BEFORE_COPY_FR },
  parent_initiated: { en: DUTY_PARENT_ASK_COPY_EN, fr: DUTY_PARENT_ASK_COPY_FR },
  which_kid: { en: DUTY_WHICH_KID_COPY, fr: DUTY_WHICH_KID_COPY_FR },
  both_claimed: { en: DUTY_BOTH_CLAIMED_COPY, fr: DUTY_BOTH_CLAIMED_COPY_FR },
  silent_parent: { en: DUTY_SILENT_PARENT_COPY_EN, fr: DUTY_SILENT_PARENT_COPY_FR },
};

export function dutyCopy(id: DutyCopyId, language: 'en' | 'fr'): string {
  return DUTY_COPY_TABLE[id][language];
}

/**
 * A line may leave only when Sloane has locked copy and the text is no longer
 * a placeholder. The sends flag is the caller's other gate.
 */
export function dutyCopyMayLeave(text: string): boolean {
  if (!dutyCopyLocked()) return false;
  if (text.includes('TODO-Design')) return false;
  return text.trim().length > 0;
}

/**
 * Append one duty line to a bubble that is already leaving. A placeholder, or
 * an unlocked copy flag, leaves the bubble unchanged.
 */
export function absorbDutyLine(weekly: string, line: string | null | undefined): string {
  if (!line || line.trim().length === 0) return weekly;
  if (!dutyCopyMayLeave(line)) return weekly;
  return `${weekly.trimEnd()}\n${line.trim()}`;
}
