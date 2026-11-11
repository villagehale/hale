import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { hasLinkShape } from '~/lib/format/link-shape';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { MatchChange } from './match';

/**
 * VIL-662 · parent ask / applied receipt, and the driver 1:1. Every parent and
 * driver text is model-written. An empty or refused draft is silence: nothing
 * is sent, and there is no fallback line.
 */

export const TEAM_SCHEDULE_PARENT_SKILL = 'team-schedule-parent';
export const TEAM_SCHEDULE_PARENT_TOOL = 'notice';
export const TEAM_SCHEDULE_PARENT_TOOL_DESCRIPTION =
  'Write the 1:1 text to the parent about this schedule change.';
export const TEAM_SCHEDULE_PARENT_MAX_TOKENS = 512;

export const TEAM_SCHEDULE_DRIVER_SKILL = 'team-schedule-driver';
export const TEAM_SCHEDULE_DRIVER_TOOL = 'line';
export const TEAM_SCHEDULE_DRIVER_TOOL_DESCRIPTION =
  'Write the 1:1 text to the driver about this schedule change.';
export const TEAM_SCHEDULE_DRIVER_MAX_TOKENS = 256;

export type TeamScheduleVoiceMode = 'ask' | 'applied';
export type SpokenChange = Exclude<MatchChange, 'none'>;

export interface TeamScheduleVoiceFacts {
  mode: TeamScheduleVoiceMode;
  kid: string | null;
  team: string | null;
  change: SpokenChange;
  was: string | null;
  when: string | null;
  place: string | null;
  language: string;
  address: 'tu' | null;
}

function frenchAddress(language: string): 'tu' | null {
  return language.toLowerCase().startsWith('fr') ? 'tu' : null;
}

export function clockOn(at: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(at);
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${date} at ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()}`;
}

export function voiceFacts(input: {
  mode: TeamScheduleVoiceMode;
  kid: string | null;
  team: string | null;
  change: SpokenChange;
  wasAt: Date | null;
  whenAt: Date | null;
  place: string | null;
  language: string;
  timeZone: string;
}): TeamScheduleVoiceFacts {
  return {
    mode: input.mode,
    kid: input.kid,
    team: input.team,
    change: input.change,
    was: input.wasAt ? clockOn(input.wasAt, input.timeZone) : null,
    when: input.whenAt ? clockOn(input.whenAt, input.timeZone) : null,
    place: input.place,
    language: input.language,
    address: frenchAddress(input.language),
  };
}

function refused(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return true;
  if (hasLinkShape(trimmed)) return true;
  if (trimmed.replace(/\D/g, '').length >= 10) return true;
  return false;
}

export function teamScheduleParentUserMessage(facts: TeamScheduleVoiceFacts): string {
  return JSON.stringify(facts);
}

export function teamScheduleDriverUserMessage(
  facts: Omit<TeamScheduleVoiceFacts, 'mode'>,
): string {
  return JSON.stringify(facts);
}

export async function composeTeamScheduleParent(
  client: AgentClient,
  facts: TeamScheduleVoiceFacts,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(TEAM_SCHEDULE_PARENT_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: parent skill load failed, nothing sent',
    );
    return null;
  }
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: teamScheduleParentUserMessage(facts),
      toolName: TEAM_SCHEDULE_PARENT_TOOL,
      toolDescription: TEAM_SCHEDULE_PARENT_TOOL_DESCRIPTION,
      inputJsonSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      schema: z.object({ text: z.string() }),
      maxTokens: TEAM_SCHEDULE_PARENT_MAX_TOKENS,
    });
    if (refused(value.text)) return null;
    return value.text.trim();
  } catch (err) {
    console.warn(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: parent compose failed',
    );
    return null;
  }
}

export async function composeTeamScheduleDriver(
  client: AgentClient,
  facts: Omit<TeamScheduleVoiceFacts, 'mode'>,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(TEAM_SCHEDULE_DRIVER_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: driver skill load failed, nothing sent',
    );
    return null;
  }
  try {
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: teamScheduleDriverUserMessage(facts),
      toolName: TEAM_SCHEDULE_DRIVER_TOOL,
      toolDescription: TEAM_SCHEDULE_DRIVER_TOOL_DESCRIPTION,
      inputJsonSchema: {
        type: 'object',
        properties: { line: { type: 'string' } },
        required: ['line'],
      },
      schema: z.object({ line: z.string() }),
      maxTokens: TEAM_SCHEDULE_DRIVER_MAX_TOKENS,
    });
    if (refused(value.line)) return null;
    return value.line.trim();
  } catch (err) {
    console.warn(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'team schedule: driver compose failed',
    );
    return null;
  }
}
