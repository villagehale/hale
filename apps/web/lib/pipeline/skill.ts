import type { Skill } from '@hale/agent';
import { loadCronSkill } from '~/lib/cron/skill';

/**
 * The inbound event pipeline's three skills — the agents' system instructions,
 * single-sourced in `packages/agent/skills/*.md` (rule #2: prompts by reference,
 * never inline). We REUSE loadCronSkill (the same resolveRepoFile + loadSkill +
 * per-name cache the scheduled agents use) rather than a second loader — the
 * skill markdown is shipped into the function bundle by next.config's
 * outputFileTracingIncludes either way.
 */
export function loadClassifyEventSkill(): Promise<Skill> {
  return loadCronSkill('classify-event');
}

export function loadDraftActionSkill(): Promise<Skill> {
  return loadCronSkill('draft-action');
}

export function loadReviewActionSkill(): Promise<Skill> {
  return loadCronSkill('review-action');
}
