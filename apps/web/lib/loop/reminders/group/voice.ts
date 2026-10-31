import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { localClockFact, localDateFact } from '~/lib/loop/reminders/compose';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { QuietShift } from './policy';

/**
 * VIL-448 (T26) — every word a group reminder says, written by the model from facts.
 *
 * Two texts: the `confirm` reply in the group (what was set, when, where it arrives, how to
 * cancel; the one question asking when; what could not be set), and the `reminder` itself.
 * Code owns the facts and the model owns the words and the shape. There is no fixed copy
 * and no fallback: a text that cannot be written after two attempts is null, and null
 * sends nothing.
 */

export const GROUP_REMINDER_VOICE_SKILL = 'group-reminder-voice';
export const GROUP_REMINDER_VOICE_TOOL = 'group_reminder_text';
export const GROUP_REMINDER_VOICE_TOOL_DESCRIPTION = 'The one text Hale sends.';
export const GROUP_REMINDER_VOICE_MAX_TOKENS = 300;
export const GROUP_REMINDER_MAX_ATTEMPTS = 2;

export interface ConfirmSetFact {
  forName: string | null;
  forEveryone: boolean;
  what: string;
  when: string;
  askedFor: string | null;
  moved: QuietShift;
  arrives: 'here' | 'private_text';
  privateAsked: boolean;
}

export interface ConfirmFacts {
  kind: 'confirm';
  language: ReplyLanguage;
  audience: 'group';
  asker: string | null;
  memberWords: string;
  now: string;
  set: ConfirmSetFact[];
  cancelled: { what: string; when: string }[];
  needsTime: { forName: string | null; forEveryone: boolean; what: string; day: string | null }[];
  notSet: { forName: string; what: string; why: 'not_in_chat' | 'name_shared' }[];
}

export interface ReminderTextFacts {
  kind: 'reminder';
  language: ReplyLanguage;
  audience: 'group' | 'direct';
  asker: string | null;
  memberWords: null;
  now: string;
  forName: string | null;
  forEveryone: boolean;
  askedByName: string | null;
  what: string;
  askedFor: string | null;
}

export type GroupReminderFacts = ConfirmFacts | ReminderTextFacts;

export interface GroupReminderVoice {
  /** The whole text, or null: nothing is sent. */
  write(facts: GroupReminderFacts): Promise<string | null>;
}

/** "Thursday, October 29, 2026 at 9:00 AM", family-local. A fact the model restates. */
export function whenFact(instant: Date, timeZone: string): string {
  return `${localDateFact(instant, timeZone)} at ${localClockFact(instant, timeZone)}`;
}

/** The user turn. Shared with the eval, which replays this request shape. */
export function groupReminderVoiceUserMessage(facts: GroupReminderFacts): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+|www\.\S+/i;

/**
 * Structural refusals only, never wording: empty, or a link. Length is the skill's to
 * judge; `GROUP_REMINDER_VOICE_MAX_TOKENS` keeps a draft far inside one Linq text part.
 */
export function groupReminderRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  return URL_SHAPE.test(text) ? ['link'] : [];
}

const outputSchema = z.object({ text: z.string() });
export const GROUP_REMINDER_VOICE_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;

export function createGroupReminderVoice(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupReminderVoice {
  return {
    async write(facts) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(GROUP_REMINDER_VOICE_SKILL);
      } catch (err) {
        console.error(
          { kind: facts.kind, err: err instanceof Error ? err.name : 'unknown' },
          'group reminder voice: skill load failed, nothing sent',
        );
        return null;
      }
      for (let attempt = 1; attempt <= GROUP_REMINDER_MAX_ATTEMPTS; attempt += 1) {
        try {
          const client =
            typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
          const { value } = await forceToolJson({
            client,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: groupReminderVoiceUserMessage(facts),
            toolName: GROUP_REMINDER_VOICE_TOOL,
            toolDescription: GROUP_REMINDER_VOICE_TOOL_DESCRIPTION,
            inputJsonSchema: GROUP_REMINDER_VOICE_SCHEMA,
            schema: outputSchema,
            maxTokens: GROUP_REMINDER_VOICE_MAX_TOKENS,
          });
          const text = value.text.trim();
          const refusals = groupReminderRefusals(text);
          if (refusals.length === 0) return text;
          console.warn({ kind: facts.kind, attempt, refusals }, 'group reminder voice: refused');
        } catch (err) {
          console.warn(
            { kind: facts.kind, attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group reminder voice: compose failed',
          );
        }
      }
      console.error(
        { kind: facts.kind, outcome: 'group_reminder_unwritten' },
        'group reminder voice: nothing sent',
      );
      return null;
    },
  };
}

let shared: GroupReminderVoice | null = null;

/** The production voice, or null when no model key is configured: a named absence. */
export function sharedGroupReminderVoice(): GroupReminderVoice | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  shared ??= createGroupReminderVoice(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
