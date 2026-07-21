import { join } from 'node:path';
import { type Skill, loadSkill } from '@hale/agent';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';

/**
 * Loads the village-search intent-parse SKILL — the parser's system instructions —
 * from the single source of truth in `packages/agent/skills/*.md` (rule #2: prompts
 * by reference, never inline). Same repo-root anchoring as the rank / Ask Hale skill
 * loaders: a Next serverless bundle relocates the package-relative skills dir, so we
 * resolve the file at the monorepo root (resolveRepoFile + outputFileTracingIncludes
 * ships it) and hand loadSkill the absolute path. One copy of the skill, cached.
 */

const PARSE_SEARCH_SKILL_REL = join('packages', 'agent', 'skills', 'parse-village-search.md');

let cached: Skill | undefined;

export async function loadParseVillageSearchSkill(): Promise<Skill> {
  cached ??= await loadSkill(resolveRepoFile(PARSE_SEARCH_SKILL_REL));
  return cached;
}
