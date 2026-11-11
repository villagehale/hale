import type { Skill } from '@hale/agent';

/**
 * VIL-577 — the 1:1 coach never offers, nor agrees, to tell the group for a family.
 *
 * Off unless GROUP_1TO1_NO_GROUP_RELAY_ENABLED is exactly the string `true`. A trailing
 * newline from `vercel env add`, `TRUE`, `on`, and `1` stay off. Unset stays off.
 * Dark leaves the coach-channel-sms bytes (and every eval cache key keyed on them)
 * unchanged. Lit, the coach-no-group-relay addendum is appended; the model writes
 * the reply, and this module writes no parent-facing copy. The private aside
 * already never offers (group-private-aside-draft.md); this covers a later 1:1
 * yes or ask, which lands on the coach, not the one-shot aside.
 */
export const GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV = 'GROUP_1TO1_NO_GROUP_RELAY_ENABLED';

export function group1to1NoGroupRelayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[GROUP_1TO1_NO_GROUP_RELAY_ENABLED_ENV] === 'true';
}

/** `null` returns the same skill object, so a dark turn's prompt is unchanged. */
export function appendNoGroupRelaySkill(skill: Skill, addendum: Skill | null): Skill {
  if (addendum === null) return skill;
  return { ...skill, instructions: `${skill.instructions}\n\n${addendum.instructions}` };
}
