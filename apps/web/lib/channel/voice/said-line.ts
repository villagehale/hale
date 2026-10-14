import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * #868 · the lines that used to be fixed, written by the model each time.
 *
 * Barton's rule: no fixed copy, no required or banned phrases. The facts a parent
 * must act on (a link, a phone number, an address) are DATA, handed in as
 * `mustInclude` and checked back verbatim; every word around them is the model's.
 * A failed or unusable write returns null and the caller pages #ops — nothing
 * canned goes out in its place.
 */

export type SaidLinePurpose =
  | 'crisis_emergency'
  | 'crisis_mental'
  | 'identity'
  | 'connector_links'
  /** They asked for a date the official page has not posted. */
  | 'not_posted'
  /** They asked for a current fact search could not ground. */
  | 'no_source'
  /** A caregiver venting: warm, not a clinician, no method, no diagnosis. */
  | 'cheer_up';

export interface SaidLineInput {
  purpose: SaidLinePurpose;
  language: ReplyLanguage | null;
  /** The parent's own words, when the line answers a text. */
  parentWords?: string | null;
  facts: Record<string, string | number | null>;
  /** Strings that must appear verbatim (links, numbers, addresses). */
  mustInclude?: readonly string[];
}

export interface SaidLineWriter {
  write(input: SaidLineInput): Promise<string | null>;
}

/** Worst-case output for one line. Crisis and identity are two or three sentences;
 * connector links carry ~140 characters of URL. */
export const SAID_LINE_MAX_TOKENS = 500;

const outputSchema = z.object({ text: z.string() });
const outputJsonSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/** The user-turn payload. Shared with the evals, which replay this request shape. */
export function saidLineUserMessage(input: SaidLineInput): string {
  return JSON.stringify({
    purpose: input.purpose,
    language: input.language,
    parentWords: input.parentWords ?? null,
    facts: input.facts,
    mustInclude: input.mustInclude ?? [],
  });
}

const URL_RE = /https?:\/\/\S+/g;

/** Structural checks only: non-empty, every required fact verbatim, no other link. */
export function acceptSaidLine(text: string, input: SaidLineInput): string | null {
  const body = text.trim();
  if (body.length === 0) return null;
  const required = input.mustInclude ?? [];
  if (!required.every((fact) => body.includes(fact))) return null;
  const links = body.match(URL_RE) ?? [];
  const allowed = required.filter((fact) => /^https?:\/\//.test(fact));
  if (links.some((link) => !allowed.some((fact) => link.startsWith(fact)))) return null;
  return body;
}

export function createSaidLineWriter(
  clientOrResolver: AgentClient | (() => AgentClient),
): SaidLineWriter {
  return {
    async write(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('said-line');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: saidLineUserMessage(input),
          toolName: 'said_line',
          toolDescription: 'Return the one text Hale sends.',
          inputJsonSchema: outputJsonSchema,
          schema: outputSchema,
          maxTokens: SAID_LINE_MAX_TOKENS,
        });
        const accepted = acceptSaidLine(value.text, input);
        if (accepted === null) {
          console.error({ purpose: input.purpose }, 'said line: unusable write - nothing sent');
        }
        return accepted;
      } catch (err) {
        console.error(
          { purpose: input.purpose, err: err instanceof Error ? err.name : 'unknown' },
          'said line: write failed - nothing sent',
        );
        return null;
      }
    },
  };
}

/** Minutes a connect link stays live, said by the model (CHANNEL_SIGNIN_TTL_MS). */
const LINK_MINUTES = 15;

/**
 * One text carrying both Google connect links, in the model's words (#868: the
 * fixed connector offer is gone). The links are the required facts. Null when the
 * write failed or no writer is wired: the caller sends nothing.
 */
export async function writeConnectorLinks(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; calendarUrl: string; gmailUrl: string },
): Promise<string | null> {
  if (!writer) {
    console.error('connector links: no line writer - nothing sent');
    return null;
  }
  return writer.write({
    purpose: 'connector_links',
    language: input.language,
    facts: {
      calendarLink: input.calendarUrl,
      gmailLink: input.gmailUrl,
      minutesValid: LINK_MINUTES,
      why: 'so Hale can spot daycare and school notices',
    },
    mustInclude: [input.calendarUrl, input.gmailUrl],
  });
}
