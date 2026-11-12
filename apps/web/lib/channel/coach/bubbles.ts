import type { Skill } from '@hale/agent';
import { isEnabled } from '@hale/flags';

/**
 * Several short bubbles for one coach answer on a 1:1 iMessage chat, dark.
 *
 * The global flag is strict equality on the literal `true` (a trailing newline from
 * `vercel env add` stays off), and the allowlist names families while it is off
 * (`coach-bubbles` in packages/flags/src/catalog.ts).
 */
export function coachBubblesEnabled(familyId: string): boolean {
  return isEnabled('coach-bubbles', familyId);
}

/** Null returns the same skill object, so a dark turn's prompt bytes are unchanged. */
export function augmentCoachSkillForBubbles(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}
