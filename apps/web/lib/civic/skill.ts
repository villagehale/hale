import type { Skill } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * The civic layer's one skill — the free-text schedule parser's system
 * instructions, single-sourced in `packages/agent/skills/parse-civic-hours.md`
 * (rule #2: prompts by reference, never inline). Reuses loadCronSkill rather than
 * adding a second loader.
 */
export function loadParseCivicHoursSkill(): Promise<Skill> {
  return loadCronSkill('parse-civic-hours');
}
