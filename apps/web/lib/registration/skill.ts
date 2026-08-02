import type { Skill } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * The registration radar's one skill — the re-verify page reader's system
 * instructions, single-sourced in
 * `packages/agent/skills/verify-registration-window.md` (rule #2: prompts by
 * reference, never inline). Reuses loadCronSkill rather than adding a loader.
 */
export function loadVerifyRegistrationWindowSkill(): Promise<Skill> {
  return loadCronSkill('verify-registration-window');
}
