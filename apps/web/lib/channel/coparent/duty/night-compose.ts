import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * The co-parent night-before text. The model writes the WHOLE message from
 * facts, in the parent's language. Every draft is fact-checked against those
 * facts by a second model call before it can send. A draft that cannot be
 * written, or that claims anything the facts do not, is NOTHING SENT: there is
 * no fallback sentence.
 */

export const DUTY_NIGHT_SKILL = 'duty-night';
export const DUTY_NIGHT_CHECK_SKILL = 'duty-night-check';

export interface DutyNightHandoff {
  name: string;
  /** Null when no child may be named. */
  kid: string | null;
  event: string;
  /** Family-local clock, handed in English. The model restates it. */
  time: string;
  /** Family-local end clock, handed in English, or null when the calendar did not say. */
  endTime: string | null;
  /** Family-local date, written out. */
  date: string;
  /** Where it is, or null when Hale holds no vetted venue. */
  venue: { name: string; address: string | null } | null;
}

export interface DutyNightUnowned {
  kid: string | null;
  event: string;
  day: string;
  time: string;
}

export interface DutyNightFacts {
  language: 'en' | 'fr';
  now: { date: string; time: string };
  handoff: DutyNightHandoff | null;
  /** A same-bubble event nobody has yet, or null. */
  unowned: DutyNightUnowned | null;
  /** A parent who has not answered, or null. */
  quiet: { name: string } | null;
}

export function dutyNightUserMessage(facts: DutyNightFacts): string {
  return JSON.stringify(facts);
}

const URL_SHAPE = /https?:\/\/\S+/i;

/** Structural refusals only: empty, or any link (none is ever handed). */
export function dutyNightRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  if (URL_SHAPE.test(text)) return ['other_link'];
  return [];
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const DUTY_NIGHT_MAX_ATTEMPTS = 2;
export const DUTY_NIGHT_MAX_TOKENS = 512;
export const DUTY_NIGHT_CHECK_MAX_TOKENS = 2048;

export interface DutyNightCheck {
  supported: boolean;
  unsupported: string[];
}

const checkSchema = z.object({
  supported: z.boolean(),
  unsupported: z.array(z.string()),
});
export const DUTY_NIGHT_CHECK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    supported: { type: 'boolean' },
    unsupported: { type: 'array', items: { type: 'string' } },
  },
  required: ['supported', 'unsupported'],
} as const;

export function dutyNightCheckMessage(facts: DutyNightFacts, text: string): string {
  return JSON.stringify({ facts, draft: text });
}

/**
 * The fact check on the draft, before it can reach the group. A model reads
 * meaning, so this is not a word list. Anything but a clean pass (a claim the
 * facts do not make, a failed or malformed check) is not sendable.
 */
export async function checkDutyNight(
  client: AgentClient,
  facts: DutyNightFacts,
  text: string,
  familyId: string,
): Promise<DutyNightCheck> {
  try {
    const skill = await loadCronSkill(DUTY_NIGHT_CHECK_SKILL);
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: dutyNightCheckMessage(facts, text),
      toolName: 'duty_night_check',
      toolDescription: 'Whether every claim in the draft is backed by the facts.',
      inputJsonSchema: DUTY_NIGHT_CHECK_JSON_SCHEMA,
      schema: checkSchema,
      maxTokens: DUTY_NIGHT_CHECK_MAX_TOKENS,
    });
    const supported = value.supported && value.unsupported.length === 0;
    return { supported, unsupported: value.unsupported };
  } catch (err) {
    console.warn(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'duty night: fact check failed, not sendable',
    );
    return { supported: false, unsupported: ['check_failed'] };
  }
}

/** The whole night-before text, or null. Null sends nothing. */
export async function composeDutyNight(
  client: AgentClient,
  facts: DutyNightFacts,
  familyId: string,
  options: { check?: typeof checkDutyNight } = {},
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(DUTY_NIGHT_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'duty night: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= DUTY_NIGHT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: dutyNightUserMessage(facts),
        toolName: 'duty_night_text',
        toolDescription: 'The one text Hale sends the group the evening before.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: DUTY_NIGHT_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = dutyNightRefusals(text);
      if (refusals.length > 0) {
        console.warn({ familyId, attempt, refusals }, 'duty night: draft refused');
        continue;
      }
      const check = await (options.check ?? checkDutyNight)(client, facts, text, familyId);
      if (check.supported) return text;
      // The claims are logged by count only: they quote family words.
      console.warn(
        { familyId, attempt, unsupported: check.unsupported.length },
        'duty night: draft failed the fact check',
      );
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'duty night: compose failed',
      );
    }
  }
  console.error({ familyId, outcome: 'duty_night_unwritten' }, 'duty night: nothing sent');
  return null;
}
