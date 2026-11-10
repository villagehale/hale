import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { Moment } from './note-compose.js';

/**
 * VIL-423 · slice 4b — the one text a household gets when the registration page moved
 * an opening Hale had already told them (recheck.ts found it). Written from facts: the
 * opening they heard, the one the page shows now. A text that cannot be written is
 * nothing sent, and the change stays owed for the next tick.
 *
 * THE LINK IS DATA, NOT COPY, as in the date-unconfirmed writer: the writer is handed no
 * link, a draft with any link shape is refused, and code appends the page on its own
 * line (`dateMovedBody`).
 */

export const REGISTRATION_DATE_MOVED_SKILL = 'registration-date-moved';

/** An opening as the parent reads it. `time` is null when the page printed no time. */
export interface OpeningMoment {
  date: string;
  time: string | null;
}

export interface DateMovedFacts {
  now: Moment;
  window: string;
  who: string;
  /** The opening Hale last told them. */
  was: OpeningMoment;
  /** The opening the page shows now. */
  opens: OpeningMoment;
}

export type DateMovedInput = DateMovedFacts & { language: ReplyLanguage };

/** Structural refusals only: empty, or any link (the writer is handed none). */
export function dateMovedRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  return hasLinkShape(text) ? ['link'] : [];
}

/** What goes on the wire: the writer's text, then the page on its own line. */
export function dateMovedBody(text: string, link: string): string {
  return `${text.trim()}\n${link}`;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const DATE_MOVED_MAX_ATTEMPTS = 2;
export const DATE_MOVED_MAX_TOKENS = 1024;
export const DATE_MOVED_TOOL = {
  name: 'registration_date_moved_text',
  description: 'The one registration text Hale sends the parent.',
} as const;

/** The whole text, or null after refused or failed attempts. Null sends nothing. */
export async function composeDateMoved(
  client: AgentClient,
  facts: DateMovedInput,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_DATE_MOVED_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'registration date moved: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= DATE_MOVED_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(facts),
        toolName: DATE_MOVED_TOOL.name,
        toolDescription: DATE_MOVED_TOOL.description,
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: DATE_MOVED_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = dateMovedRefusals(text);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'registration date moved: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration date moved: compose failed',
      );
    }
  }
  console.error(
    { familyId, outcome: 'registration_date_moved_unwritten' },
    'registration date moved: nothing sent',
  );
  return null;
}
