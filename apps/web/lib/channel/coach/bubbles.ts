import type { Skill } from '@hale/agent';
import { isEnabled } from '@hale/flags';

/**
 * Several short bubbles for one coach answer on a 1:1 iMessage chat. Lit, it also paces
 * the family's other multi-bubble iMessage sends (linq/bubble-gap.ts).
 *
 * A kill switch: on unless COACH_BUBBLES_ENABLED is `false` (trimmed), with no family
 * allowlist (`coach-bubbles` in packages/flags/src/catalog.ts).
 */
export function coachBubblesEnabled(familyId: string): boolean {
  return isEnabled('coach-bubbles', familyId);
}

/** Null returns the same skill object, so a dark turn's prompt bytes are unchanged. */
export function augmentCoachSkillForBubbles(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}
