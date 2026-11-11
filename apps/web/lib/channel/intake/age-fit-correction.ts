import type { Skill } from '@hale/agent';

/**
 * VIL-568 — agree with a parent's age-fit correction and stop offering that program.
 *
 * Off unless AGE_FIT_CORRECTION_ENABLED is exactly the string `true`. A trailing
 * newline from `vercel env add`, `TRUE`, `on`, and `1` stay off. Unset stays off.
 * Dark leaves the coach and onboarding-friend bytes (and every eval cache key
 * keyed on them) unchanged. Lit, the age-fit-correction addendum is appended;
 * the model writes the reply, and this module writes no parent-facing copy.
 */
export const AGE_FIT_CORRECTION_ENABLED_ENV = 'AGE_FIT_CORRECTION_ENABLED';

export function ageFitCorrectionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[AGE_FIT_CORRECTION_ENABLED_ENV] === 'true';
}

/** `null` returns the same skill object, so a dark turn's prompt is unchanged. */
export function appendAgeFitCorrectionSkill(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}
