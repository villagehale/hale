import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { inShape } from '@hale/types';
import { z } from 'zod';
import { withLlmContext } from '~/lib/analytics/llm-trace';
import { smallerLane } from '~/lib/channel/spoken-line';
import { loadCronSkill } from '~/lib/cron/skill';
import { contactsOutside } from '~/lib/format/contact-shape';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import { sharedOpsPager } from '~/lib/monitoring/shared-ops-pager';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-745 · the model writes the one text a party guest gets (skill `party-guest-line`),
 * from the facts below and nothing else: no number, no other guest, nothing about the
 * family. The skill's lane first, then a smaller model, then nothing: null means no text
 * goes out and #ops is paged. There is no fallback sentence.
 *
 * Server-side on purpose: ./guest-copy.ts runs in a browser bundle and keeps zero imports.
 */

export interface PartyGuestLine {
  why: 'asked_for_reminder' | 'host_cancelled';
  /** After redactTeenNames. */
  title: string;
  when: string;
  /** After redactTeenNames. */
  where: string | null;
}

export interface PartyGuestLineWriter {
  write(line: PartyGuestLine): Promise<string | null>;
}

export const PARTY_GUEST_LINE_MAX_TOKENS = 400;

export const PARTY_GUEST_LINE_TOOL = {
  name: 'party_guest_line',
  description: 'Write the one text this party guest gets.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
} as const;

const outputSchema = z.object({ text: z.string() });

/** Names each fact, so a field added to the input cannot reach the model by accident. */
export function partyGuestLineUserMessage(line: PartyGuestLine): string {
  return JSON.stringify({
    why: line.why,
    title: line.title,
    when: line.when,
    where: line.where,
  });
}

const NAMES_HALE = /\bHale\b/;
const TRAILING_PUNCTUATION = /[\s.,;:!?]+$/;

/** These two read Hale's own draft on its `inShape` form, never a person's words. */
const SHOUTED_KEYWORD = /\b(?:STOP|HELP|START|UNSUBSCRIBE|ARRET|AIDE)\b/;
/** "To help" is an ordinary infinitive ("text you to help you remember"). "To stop" is a way out. */
const SENT_KEYWORD =
  /\b(?:reply|respond|text|send|type|write|say|repond\w*|textez|envoy\w*|ecri\w*|tapez|dites)\b[^.!?\n]{0,32}?\b(?:stop|unsubscribe|arret|(?<!\bto )(?:help|aide))\b/i;

/**
 * Whether the draft teaches a word to send. A fact's own words do not count ("Bus STOP
 * Cafe"), unless the fact is itself an instruction: then it is read like the rest.
 */
function namesKeyword(body: string, facts: readonly string[]): boolean {
  const outsideFacts = facts
    .map(inShape)
    .filter((fact) => fact.length > 0 && !SENT_KEYWORD.test(fact))
    .reduce((rest, fact) => rest.split(fact).join('\n'), inShape(body));
  return SHOUTED_KEYWORD.test(outsideFacts) || SENT_KEYWORD.test(outsideFacts);
}

function carriesPlace(body: string, where: string): boolean {
  const place = inShape(where).toLowerCase().replace(TRAILING_PUNCTUATION, '');
  return inShape(body).toLowerCase().includes(place);
}

/**
 * The text as it may be sent, or null. It must say it is from Hale, because the guest has
 * no idea whose number this is. A reminder must carry the place the host typed. Only the
 * place may carry a link, phone or email: a title is the host's free text, and a contact
 * in it is not grounds to repeat it to a stranger.
 */
export function acceptPartyGuestLine(text: string, line: PartyGuestLine): string | null {
  const body = text.trim();
  if (body.length === 0 || hasGarbledText(body) || !NAMES_HALE.test(body)) return null;
  if (line.why === 'asked_for_reminder' && line.where !== null) {
    if (!carriesPlace(body, line.where)) return null;
  }
  if (contactsOutside(body, line.where === null ? [] : [line.where]).length > 0) return null;
  const facts = line.where === null ? [line.title] : [line.title, line.where];
  return namesKeyword(body, facts) ? null : body;
}

export function createPartyGuestLineWriter(
  client: () => AgentClient,
  pager: OpsPager,
): PartyGuestLineWriter {
  return {
    async write(line) {
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('party-guest-line');
      } catch (err) {
        console.error(
          { why: line.why, err: err instanceof Error ? err.name : 'unknown' },
          'party guest line: skill load failed',
        );
        await pager.page({
          site: 'party_guest_unwritten',
          facts: { why: line.why, stage: 'skill_load' },
        });
        return null;
      }
      const first = pickLane(skill.meta.task);
      const lanes = [first, smallerLane(first)];
      for (let attempt = 0; attempt < lanes.length; attempt += 1) {
        try {
          // A guest is not a customer: the party's words never ride in an analytics trace.
          const { value } = await withLlmContext({ stage: 'reminder', omitContent: true }, () =>
            forceToolJson({
              client: client(),
              lane: lanes[attempt] ?? first,
              system: skill.instructions,
              userMessage: partyGuestLineUserMessage(line),
              toolName: PARTY_GUEST_LINE_TOOL.name,
              toolDescription: PARTY_GUEST_LINE_TOOL.description,
              inputJsonSchema: PARTY_GUEST_LINE_TOOL.inputSchema,
              schema: outputSchema,
              maxTokens: PARTY_GUEST_LINE_MAX_TOKENS,
            }),
          );
          const accepted = acceptPartyGuestLine(value.text, line);
          if (accepted) return accepted;
          console.warn({ attempt: attempt + 1, why: line.why }, 'party guest line: unusable text');
        } catch (err) {
          console.error(
            {
              attempt: attempt + 1,
              why: line.why,
              err: err instanceof Error ? err.name : 'unknown',
            },
            'party guest line: write failed',
          );
        }
      }
      await pager.page({
        site: 'party_guest_unwritten',
        facts: { why: line.why, stage: 'after_retry' },
      });
      return null;
    },
  };
}

let shared: PartyGuestLineWriter | null = null;

export function sharedPartyGuestLineWriter(): PartyGuestLineWriter {
  shared ??= createPartyGuestLineWriter(
    () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS, { stage: 'reminder' }),
    sharedOpsPager,
  );
  return shared;
}
