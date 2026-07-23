import { join } from 'node:path';
import { type Skill, loadSkill } from '@hale/agent';
import { resolveRepoFile } from '~/lib/coach/resolve-repo-file';

/**
 * Loads a SKILL — an agent's system instructions — from the single source of
 * truth in `packages/agent/skills/<name>.md` (rule #2: prompts by reference,
 * never inline). Same repo-root resolution as the coach's loadAskHaleSkill: a
 * Next serverless bundle relocates the package-relative skills dir, so we resolve
 * the absolute path (next.config.ts ships the skill files via
 * outputFileTracingIncludes) and hand it to loadSkill. Cached per skill name.
 */
const cache = new Map<string, Skill>();

export async function loadCronSkill(name: string): Promise<Skill> {
  const existing = cache.get(name);
  if (existing) return existing;
  const skill = await loadSkill(resolveRepoFile(join('packages', 'agent', 'skills', `${name}.md`)));
  cache.set(name, skill);
  return skill;
}

export function loadDailyBriefSkill(): Promise<Skill> {
  return loadCronSkill('daily-brief');
}

export function loadInferMemorySkill(): Promise<Skill> {
  return loadCronSkill('infer-memory');
}

export function loadWeekSummarySkill(): Promise<Skill> {
  return loadCronSkill('week-summary');
}

export function loadWelcomeVoiceSkill(): Promise<Skill> {
  return loadCronSkill('welcome-voice');
}
