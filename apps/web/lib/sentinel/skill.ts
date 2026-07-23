import type { Skill } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * The E2 sentinel's two skills — the triage/extraction agents' system
 * instructions, single-sourced in `packages/agent/skills/*.md` (rule #2: prompts
 * by reference, never inline). REUSES loadCronSkill (the same resolveRepoFile +
 * loadSkill + per-name cache the pipeline's classify/draft skills use) rather
 * than a second loader.
 */
export function loadTriageChildEventSkill(): Promise<Skill> {
  return loadCronSkill('triage-child-event');
}

export function loadExtractChildEventSkill(): Promise<Skill> {
  return loadCronSkill('extract-child-event');
}
