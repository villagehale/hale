import { join } from 'node:path';
import { type Skill, loadSkill } from '@hale/agent';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';

/**
 * Loads the village-ranking SKILLS — the agents' system instructions — from the
 * single source of truth in `packages/agent/skills/*.md` (rule #2: prompts by
 * reference, never inline). Same repo-root anchoring as the Concierge skill loader:
 * a Next serverless bundle relocates the package-relative skills dir, so we
 * resolve the file at the monorepo root (resolveRepoFile + outputFileTracingIncludes
 * ships it) and hand `loadSkill` the absolute path. One copy of each skill, never
 * duplicated.
 */

const RANK_SKILL_REL = join('packages', 'agent', 'skills', 'rank-recommendations.md');
const CURATE_SKILL_REL = join('packages', 'agent', 'skills', 'curate-shortlist.md');

let rankCached: Skill | undefined;
let curateCached: Skill | undefined;

export async function loadRankSkill(): Promise<Skill> {
  rankCached ??= await loadSkill(resolveRepoFile(RANK_SKILL_REL));
  return rankCached;
}

export async function loadCurateSkill(): Promise<Skill> {
  curateCached ??= await loadSkill(resolveRepoFile(CURATE_SKILL_REL));
  return curateCached;
}
