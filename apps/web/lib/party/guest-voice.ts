import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { inShape } from '@hale/types';
import { z } from 'zod';
import { withLlmContext } from '~/lib/analytics/llm-trace';
import { smallerLane } from '~/lib/channel/spoken-line';
import { loadCronSkill } from '~/lib/cron/skill';
import { contactsOutside } from '~/lib/format/contact-shape';
import type { OpsPager, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import { sharedOpsPager } from '~/lib/monitoring/shared-ops-pager';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-745 · the model writes the one text a party guest gets (skill `party-guest-line`),
 * from the facts below and nothing else: no number, no other guest, nothing about the
 * family. The skill's lane first, then a smaller model, then nothing: `unwritten` means no
 * text goes out and #ops is paged. There is no fallback sentence.
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

/** `page` says whether anyone was told: a page that did not leave is its own outcome. */
export type PartyGuestLineOutcome =
  | { status: 'written'; text: string }
  | { status: 'unwritten'; page: OpsPagerOutcome };

export interface PartyGuestLineWriter {
  write(line: PartyGuestLine): Promise<PartyGuestLineOutcome>;
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
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const SHOUTED_WORD = /(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu;
/** A number to text back. Too short for the phone check, and no party fact needs one. */
const SHORT_CODE = /(?<!\d)\d{5,6}(?!\d)/;
/** The clock `partyWhen` ends on: "2:30 PM". */
const WHEN_CLOCK = /(\d{1,2}):(\d{2}) ([AP])M$/;

function factsIn(line: PartyGuestLine): string[] {
  return (line.where === null ? [line.title] : [line.title, line.where])
    .map(inShape)
    .filter((fact) => fact.length > 0);
}

/** The draft on its `inShape` form, less the title and place wherever it repeats them whole. */
function outsideFacts(body: string, line: PartyGuestLine): string {
  return factsIn(line).reduce((rest, fact) => rest.split(fact).join('\n'), inShape(body));
}

/** Where `run` first stands as whole words: "114 Elm St" does not hold "14 Elm St". */
function wholeRunAt(text: string, run: string): number {
  for (let at = text.indexOf(run); at !== -1; at = text.indexOf(run, at + 1)) {
    const before = text[at - 1] ?? '';
    const after = text[at + run.length] ?? '';
    if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return at;
  }
  return -1;
}

function lessOneMention(text: string, fact: string): string {
  const at = wholeRunAt(text, fact);
  return at === -1 ? text : `${text.slice(0, at)}\n${text.slice(at + fact.length)}`;
}

/**
 * Whether the draft shouts a word the party's facts do not hold. A keyword to text back is
 * written in capitals in every language, so this needs no list of keywords. A title or
 * place the host typed in capitals is theirs for ONE mention each: a place called "STOP"
 * must not exempt a second STOP in the same text. The time's PM is a fact. A lowercase
 * keyword is the skill's and the eval's to catch.
 */
function shoutsOutsideFacts(body: string, line: PartyGuestLine): boolean {
  const timeWords = new Set(inShape(line.when).match(SHOUTED_WORD));
  const rest = factsIn(line).reduce(lessOneMention, inShape(body));
  return (rest.match(SHOUTED_WORD) ?? []).some((word) => !timeWords.has(word));
}

function carriesPlace(body: string, where: string): boolean {
  const place = inShape(where).toLowerCase().replace(TRAILING_PUNCTUATION, '');
  if (place.length === 0) return true;
  return wholeRunAt(inShape(body).toLowerCase(), place) !== -1;
}

/**
 * Whether the draft gives the party's time in digits, on a 12- or 24-hour clock: "2 PM",
 * "2:00", "14 h", "14h30". Read outside the title and place, whose numbers are not the
 * time. A `when` that does not parse cannot be checked, so it refuses.
 */
function carriesClock(outside: string, when: string): boolean {
  const match = WHEN_CLOCK.exec(inShape(when));
  if (match === null) return false;
  const [, hour, minutes, half] = match;
  const hour12 = Number(hour);
  const hour24 = (hour12 % 12) + (half === 'P' ? 12 : 0);
  const hours = `(?<!\\d)(?:${hour12}|${hour24})`;
  const marker = (letter: string) => `\\s?${letter}(?:\\.\\s?)?m\\b`;
  const notWrongHalf = `(?!${marker(half === 'P' ? 'a' : 'p')})`;
  const clock =
    minutes === '00'
      ? `${hours}(?::00(?!\\d)${notWrongHalf}|${marker(half as string)}|\\s?h(?!\\s?(?:[1-5]\\d|0[1-9])))`
      : `${hours}\\s?[:h]\\s?${minutes}(?!\\d)${notWrongHalf}`;
  return new RegExp(clock, 'i').test(outside);
}

/**
 * The text as it may be sent, or null. It must say it is from Hale, because the guest has
 * no idea whose number this is. A reminder must carry the place the host typed and the
 * party's time. Only the place may carry a link, phone or email: a title is the host's
 * free text, and a contact in it is not grounds to repeat it to a stranger.
 */
export function acceptPartyGuestLine(text: string, line: PartyGuestLine): string | null {
  const body = text.trim();
  if (body.length === 0 || hasGarbledText(body) || !NAMES_HALE.test(body)) return null;
  const outside = outsideFacts(body, line);
  if (line.why === 'asked_for_reminder') {
    if (line.where !== null && !carriesPlace(body, line.where)) return null;
    if (!carriesClock(outside, line.when)) return null;
  }
  if (contactsOutside(body, line.where === null ? [] : [line.where]).length > 0) return null;
  if (SHORT_CODE.test(outside)) return null;
  return shoutsOutsideFacts(body, line) ? null : body;
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
        const page = await pager.page({
          site: 'party_guest_unwritten',
          facts: { why: line.why, stage: 'skill_load' },
        });
        return { status: 'unwritten', page };
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
          if (accepted) return { status: 'written', text: accepted };
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
      const page = await pager.page({
        site: 'party_guest_unwritten',
        facts: { why: line.why, stage: 'after_retry' },
      });
      return { status: 'unwritten', page };
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
