import { join } from 'node:path';
import { loadSkill, type Skill } from '@hale/agent';
import { resolveRepoFile } from './resolve-repo-file';

/**
 * Loads the `ask-hale` SKILL — the agent's system instructions — from the single
 * source of truth in `packages/agent/skills/ask-hale.md` (rule #2: prompts by
 * reference, never inline). The harness's own `loadSkill` resolves a bare name
 * against its package-relative `skills/` dir via `import.meta.url`, which a Next
 * serverless bundle relocates; so we resolve the file at the monorepo root the
 * same way the coach prompt loader does (resolveRepoFile + outputFileTracingIncludes
 * ships the file into the function) and hand `loadSkill` the absolute path. One
 * copy of the skill in the repo, never duplicated.
 */

const SKILL_REL = join('packages', 'agent', 'skills', 'ask-hale.md');

let cached: Skill | undefined;

export async function loadAskHaleSkill(): Promise<Skill> {
  cached ??= await loadSkill(resolveRepoFile(SKILL_REL));
  return cached;
}
