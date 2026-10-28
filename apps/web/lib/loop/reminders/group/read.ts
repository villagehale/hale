import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';
import type { ReminderAsk } from './policy';

/**
 * VIL-448 (T26) — the model reads whether a group message is a reminder ask.
 *
 * The `group-reminder-read` skill reads the words, in any wording and any language: is
 * the whole message about setting, moving or cancelling reminders, and if so, each one —
 * who for, what, and when as the person said it. Code checks the reading and does the
 * rest. A failed read is null, and the turn goes on to the coach as it does today.
 */

export const GROUP_REMINDER_READ_SKILL = 'group-reminder-read';
export const GROUP_REMINDER_READ_TOOL = 'group_reminder_read';
export const GROUP_REMINDER_READ_MAX_TOKENS = 600;
/** How many earlier group lines the read sees. */
export const GROUP_REMINDER_RECENT_LINES = 6;

export interface GroupReminderOpen {
  ref: string;
  /** `sender`, `everyone`, or the first name of who it is for; null when no name is known. */
  for: string | null;
  what: string;
  when: string;
}

export interface GroupReminderReadInput {
  message: string;
  sender: string | null;
  people: string[];
  recent: { from: 'hale' | 'member'; text: string }[];
  now: {
    date: string;
    weekday: string;
    time: string;
    nextDays: { date: string; weekday: string }[];
  };
  open: GroupReminderOpen[];
}

export interface GroupReminderReading {
  request: 'reminders' | 'other';
  set: ReminderAsk[];
  cancel: string[];
  language: string;
}

export interface GroupReminderReader {
  /** Null: the read failed after its retry. */
  read(input: GroupReminderReadInput): Promise<GroupReminderReading | null>;
}

const askSchema = z.object({
  for: z.enum(['sender', 'person', 'everyone']),
  name: z.string().nullable(),
  what: z.string(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  inMinutes: z.number().nullable(),
  where: z.enum(['group', 'private', 'unsaid']),
});

const outputSchema = z.object({
  request: z.enum(['reminders', 'other']),
  set: z.array(askSchema),
  cancel: z.array(z.string()),
  language: z.string(),
});

export const GROUP_REMINDER_READ_SCHEMA = {
  type: 'object',
  properties: {
    request: { type: 'string', enum: ['reminders', 'other'] },
    set: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          for: { type: 'string', enum: ['sender', 'person', 'everyone'] },
          name: { type: ['string', 'null'] },
          what: { type: 'string' },
          date: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null.' },
          time: { type: ['string', 'null'], description: 'HH:MM, 24-hour, or null.' },
          inMinutes: { type: ['integer', 'null'] },
          where: { type: 'string', enum: ['group', 'private', 'unsaid'] },
        },
        required: ['for', 'name', 'what', 'date', 'time', 'inMinutes', 'where'],
        additionalProperties: false,
      },
    },
    cancel: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
  },
  required: ['request', 'set', 'cancel', 'language'],
  additionalProperties: false,
} as const;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupReminderReadUserMessage(input: GroupReminderReadInput): string {
  return JSON.stringify({
    ...input,
    recent: input.recent.slice(-GROUP_REMINDER_RECENT_LINES),
  });
}

function weekdayIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(instant);
}

/** `now` as the reader sees it: the local date, weekday and clock, and the coming week. */
export function readerNow(now: Date, timeZone: string): GroupReminderReadInput['now'] {
  const today = dayKeyIn(now, timeZone);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(now);
  const nextDays = Array.from({ length: 8 }, (_, i) => {
    const date = addDaysToKey(today, i);
    return { date, weekday: weekdayIn(new Date(`${date}T12:00:00Z`), 'UTC') };
  });
  return { date: today, weekday: weekdayIn(now, timeZone), time, nextDays };
}

export function createGroupReminderReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupReminderReader {
  const once = async (input: GroupReminderReadInput): Promise<GroupReminderReading> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill(GROUP_REMINDER_READ_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupReminderReadUserMessage(input),
      toolName: GROUP_REMINDER_READ_TOOL,
      toolDescription: 'Return whether this group message asks for reminders, and each one.',
      inputJsonSchema: GROUP_REMINDER_READ_SCHEMA,
      schema: outputSchema,
      maxTokens: GROUP_REMINDER_READ_MAX_TOKENS,
    });
    return value;
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await once(input);
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group reminder reader: read failed',
          );
        }
      }
      console.error({ outcome: 'group_reminder_unread' }, 'group reminder reader: not read');
      return null;
    },
  };
}

let shared: GroupReminderReader | null = null;

export function sharedGroupReminderReader(): GroupReminderReader {
  shared ??= createGroupReminderReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}
