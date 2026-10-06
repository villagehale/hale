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

export function loadInferMemorySkill(): Promise<Skill> {
  return loadCronSkill('infer-memory');
}

export function loadWeekSummarySkill(): Promise<Skill> {
  return loadCronSkill('week-summary');
}

export function loadWelcomeVoiceSkill(): Promise<Skill> {
  return loadCronSkill('welcome-voice');
}

export function loadReminderVoiceSkill(): Promise<Skill> {
  return loadCronSkill('reminder-voice');
}

export function loadRadarVoiceSkill(): Promise<Skill> {
  return loadCronSkill('radar-voice');
}

export function loadNudgeVoiceSkill(): Promise<Skill> {
  return loadCronSkill('nudge-voice');
}

export function loadReplyCopySkill(): Promise<Skill> {
  return loadCronSkill('reply-copy');
}

export function loadIntakeVoiceSkill(): Promise<Skill> {
  return loadCronSkill('intake-voice');
}

export function loadOnboardingFriendSkill(): Promise<Skill> {
  return loadCronSkill('onboarding-friend');
}

/** The smaller, step-aware prompt for the one retry after a failed onboarding reply. */
export function loadOnboardingFriendShortSkill(): Promise<Skill> {
  return loadCronSkill('onboarding-friend-short');
}

/** Which calendar and mail items are about the kids, before a wow moment is written. */
export function loadKidItemClassifierSkill(): Promise<Skill> {
  return loadCronSkill('kid-item-classifier');
}
