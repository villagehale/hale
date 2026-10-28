import { type AgentClient, HAIKU_MODEL, type LaneConfig, pickLane } from '@hale/agent';
import { z } from 'zod';
import { type ReplyLanguage, localeFor } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-443 (T17) 1/2 — the text that tells the family group where its plan landed.
 *
 * A plan the group made, approved by a parent, is placed on the household's calendar by
 * the executor (and on the approver's own Google calendar when T6 writes it). This module
 * turns what code knows about that placement into the facts for ONE AI-written group text
 * (skill `group-plan-calendar-report`): whose own calendars it reached, who it is not on
 * yet, and the one add-to-calendar link anyone in the chat can tap, Hale customer or not.
 * Code owns the facts and the link; the model writes the words. There is no fixed copy and
 * no word check, only structural gates, and a draft refused twice sends nothing.
 */

export const GROUP_PLAN_REPORT_SKILL = 'group-plan-calendar-report';
export const GROUP_PLAN_REPORT_TOOL = 'group_plan_report';

/** Exactly `true` arms the group report. Anything else leaves today's 1:1 invites alone. */
export function groupPlanReportEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GROUP_PLAN_CALENDAR_REPORT_ENABLED?.trim() === 'true';
}

export type GroupPlanChange = 'added' | 'moved' | 'cancelled';

export interface GroupPlanEvent {
  title: string;
  /** Already rendered in the family's time zone and language. */
  when: string;
  where: string | null;
}

/** One person in the group, as far as code knows them. */
export interface GroupPlanMember {
  userId: string;
  /** Spoken first name, or null when Hale has none. */
  firstName: string | null;
}

export interface GroupPlanReportInput {
  change: GroupPlanChange;
  event: GroupPlanEvent;
  onCalendarOf: string[];
  notYet: string[];
  othersNotYet: number;
  everyone: boolean;
  link: string | null;
  language: ReplyLanguage;
}

/** The plan's time, in the family's own zone and language. */
export function planWhenLabel(startsAt: Date, timeZone: string, language: ReplyLanguage): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(startsAt);
}

function distinct(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * The facts the skill is handed. A cancel names nobody and carries no link: the link 404s
 * once the event is gone. A placement with no link to give is refused (null) rather than
 * sent without the one thing that puts it on everyone else's calendar. `everyone` is true
 * only when every known member is one Hale actually wrote it for.
 */
export function groupPlanReportInput(args: {
  change: GroupPlanChange;
  event: GroupPlanEvent;
  members: readonly GroupPlanMember[];
  /** Members whose own calendar Hale wrote this placement to. */
  reachedUserIds: readonly string[];
  link: string | null;
  language: ReplyLanguage;
}): GroupPlanReportInput | null {
  if (args.change === 'cancelled') {
    return {
      change: 'cancelled',
      event: args.event,
      onCalendarOf: [],
      notYet: [],
      othersNotYet: 0,
      everyone: false,
      link: null,
      language: args.language,
    };
  }
  if (!args.link) return null;
  const reached = new Set(args.reachedUserIds);
  const onCalendarOf: string[] = [];
  const notYet: string[] = [];
  let othersNotYet = 0;
  for (const member of args.members) {
    if (reached.has(member.userId)) {
      if (member.firstName) onCalendarOf.push(member.firstName);
    } else if (member.firstName) {
      notYet.push(member.firstName);
    } else {
      othersNotYet += 1;
    }
  }
  return {
    change: args.change,
    event: args.event,
    onCalendarOf: distinct(onCalendarOf),
    notYet: distinct(notYet),
    othersNotYet,
    everyone: args.members.length > 0 && args.members.every((m) => reached.has(m.userId)),
    link: args.link,
    language: args.language,
  };
}

/**
 * The user turn. Shared with the eval, which replays the first attempt's shape. A retry
 * carries what the last draft got wrong, so the second attempt is not a blind re-roll.
 */
export function groupPlanReportUserMessage(
  input: GroupPlanReportInput,
  lastDraftRefused: readonly string[] = [],
): string {
  return JSON.stringify(lastDraftRefused.length > 0 ? { ...input, lastDraftRefused } : input);
}

/** A backstop over the skill's "about 160", measured without the link. */
export const GROUP_PLAN_REPORT_MAX_CHARS = 200;
const URL_SHAPE = /https?:\/\/\S+/gi;
const QUESTION_MARK = /[?\uFF1F\u00BF]/;
const TRAILING_PUNCTUATION = /[.,;:!)\]}"'\u00BB\u201D\u2019\u3002\uFF0C]+$/u;

/**
 * Structural refusals only, never wording: empty, too long, a question, a link that is not
 * the one handed, or a handed link that did not make it in exactly once.
 */
export function groupPlanReportRefusals(body: string, input: GroupPlanReportInput): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  const found: string[] = [];
  const urls = text.match(URL_SHAPE) ?? [];
  const words = text.replace(URL_SHAPE, '').trim();
  if (words.length > GROUP_PLAN_REPORT_MAX_CHARS) found.push('over_char_cap');
  if (QUESTION_MARK.test(words)) found.push('asks_question');
  const link = input.link;
  if (link === null) {
    if (urls.length > 0) found.push('carries_link');
    return found;
  }
  const copies = text.split(link).length - 1;
  if (copies === 0) found.push('link_missing');
  if (copies > 1) found.push('link_repeated');
  if (urls.some((url) => url.replace(TRAILING_PUNCTUATION, '') !== link)) found.push('other_link');
  return found;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/** The second attempt's lane: the small model with thinking off. */
const RETRY_LANE: LaneConfig = { model: HAIKU_MODEL, thinking: 'disabled', effort: 'medium' };
export const GROUP_PLAN_REPORT_MAX_TOKENS = 300;

/**
 * One text, or null when both attempts were refused or failed. The first runs on the
 * skill's lane, the second on the small lane with the refusal reasons. Null sends nothing:
 * a group text that can't be written well is not replaced by canned copy.
 */
export async function composeGroupPlanReport(
  client: AgentClient,
  input: GroupPlanReportInput,
): Promise<string | null> {
  const skill = await loadCronSkill(GROUP_PLAN_REPORT_SKILL);
  const lanes = [pickLane(skill.meta.task), RETRY_LANE];
  let refused: string[] = [];
  for (const [index, lane] of lanes.entries()) {
    try {
      const { value } = await forceToolJson({
        client,
        lane,
        system: skill.instructions,
        userMessage: groupPlanReportUserMessage(input, refused),
        toolName: GROUP_PLAN_REPORT_TOOL,
        toolDescription: 'The one text Hale sends the family group.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: GROUP_PLAN_REPORT_MAX_TOKENS,
      });
      const text = value.text.trim();
      refused = groupPlanReportRefusals(text, input);
      if (refused.length === 0) return text;
      console.warn({ attempt: index + 1, refusals: refused }, 'group plan report: draft refused');
    } catch (err) {
      console.warn(
        { attempt: index + 1, err: err instanceof Error ? err.name : 'unknown' },
        'group plan report: compose failed',
      );
    }
  }
  return null;
}
