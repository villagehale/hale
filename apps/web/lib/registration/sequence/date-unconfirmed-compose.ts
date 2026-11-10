import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { Moment } from './note-compose.js';

/**
 * VIL-423 · the reminder a ladder leg becomes when the send-time date check could not
 * corroborate the stored opening (date-check.ts, `enforce`). The facts carry no date, so
 * the text cannot state the unconfirmed one: it says the page did not confirm it and
 * points at the page. A text that cannot be written is nothing sent.
 *
 * THE LINK IS DATA, NOT COPY, as in the spot-open and plan writers. The writer is handed
 * no link and a draft carrying any link shape is refused; code appends the window's page
 * on its own line (`dateUnconfirmedBody`). A retyped link could slip a character, or be
 * swapped for a look-alike host.
 */

export const REGISTRATION_DATE_UNCONFIRMED_SKILL = 'registration-date-unconfirmed';

export interface DateUnconfirmedFacts {
  now: Moment;
  window: string;
  who: string;
  why: 'page_unreadable' | 'page_unconfirmed';
  /** True for a household that has not yet said yes: the text asks once. */
  offer: boolean;
}

export type DateUnconfirmedInput = DateUnconfirmedFacts & { language: ReplyLanguage };

/** Structural refusals only: empty, or any link (the writer is handed none). */
export function dateUnconfirmedRefusals(body: string): string[] {
  const text = body.trim();
  if (text === '') return ['empty'];
  return hasLinkShape(text) ? ['link'] : [];
}

/** What goes on the wire: the writer's text, then the window's page on its own line. */
export function dateUnconfirmedBody(text: string, link: string): string {
  return `${text.trim()}\n${link}`;
}

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

export const DATE_UNCONFIRMED_MAX_ATTEMPTS = 2;
export const DATE_UNCONFIRMED_MAX_TOKENS = 1024;
export const DATE_UNCONFIRMED_TOOL = {
  name: 'registration_date_unconfirmed_text',
  description: 'The one registration text Hale sends the parent.',
} as const;

/** The whole text, or null after refused or failed attempts. Null sends nothing. */
export async function composeDateUnconfirmed(
  client: AgentClient,
  facts: DateUnconfirmedInput,
  familyId: string,
): Promise<string | null> {
  let skill: Awaited<ReturnType<typeof loadCronSkill>>;
  try {
    skill = await loadCronSkill(REGISTRATION_DATE_UNCONFIRMED_SKILL);
  } catch (err) {
    console.error(
      { familyId, err: err instanceof Error ? err.name : 'unknown' },
      'registration date unconfirmed: skill load failed, nothing sent',
    );
    return null;
  }
  for (let attempt = 1; attempt <= DATE_UNCONFIRMED_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify(facts),
        toolName: DATE_UNCONFIRMED_TOOL.name,
        toolDescription: DATE_UNCONFIRMED_TOOL.description,
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: DATE_UNCONFIRMED_MAX_TOKENS,
      });
      const text = value.text.trim();
      const refusals = dateUnconfirmedRefusals(text);
      if (refusals.length === 0) return text;
      console.warn({ familyId, attempt, refusals }, 'registration date unconfirmed: draft refused');
    } catch (err) {
      console.warn(
        { familyId, attempt, err: err instanceof Error ? err.name : 'unknown' },
        'registration date unconfirmed: compose failed',
      );
    }
  }
  console.error(
    { familyId, outcome: 'registration_date_unconfirmed_unwritten' },
    'registration date unconfirmed: nothing sent',
  );
  return null;
}
