import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { inShape } from '@hale/types';
import { z } from 'zod';
import { withLlmContext } from '~/lib/analytics/llm-trace';
import { namesKeyword } from '~/lib/channel/no-stop-keyword';
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
const LETTER = /\p{L}/u;
const SHOUTED_WORD = /(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu;
/**
 * Five digits in a draft with only spaces or punctuation between them: more than a day or
 * a time needs, so it can be a number to text back. `\n` marks a number already lifted.
 */
const LONG_NUMBER = /\p{Nd}(?:[^\p{L}\p{N}\n]*\p{Nd}){4}/u;
const LONG_NUMBER_IN_TITLE = /\p{Nd}(?:[^\p{L}\p{N}]*\p{Nd}){4,}/gu;
/** Read within one part of a place, because a comma parts an address. */
const LONG_NUMBER_IN_PLACE = /\p{Nd}(?:[^\p{L}\p{N},]*\p{Nd}){4,}/gu;
/** Opens the place or a comma part, with a street name next: "12-345 Main St". */
const STREET_NUMBER = /(?<=^|,\s*)\p{Nd}+(?:-\p{Nd}+)?(?=,?\s+\p{L})/gu;
/** A full phone number in one part of a place, which a host may hand to guests. */
const PLACE_PHONE = /\p{Nd}(?:[^\p{L}\p{N},]*\p{Nd}){9,}/gu;
/** The clock `partyWhen` ends on: "2:30 PM". */
const WHEN_CLOCK = /(\d{1,2}):(\d{2}) ([AP])M$/;

function numbersAPlaceMayHold(place: string) {
  return [...place.matchAll(STREET_NUMBER), ...place.matchAll(PLACE_PHONE)];
}

function cutNumbers(fact: string, numbers: RegExp, keeps: (at: number) => boolean): string {
  const cut = fact.replace(numbers, (run: string, at: number) => (keeps(at) ? run : ' '));
  if (cut === fact) return fact;
  return cut
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:-]+$/, '')
    .trim();
}

/**
 * A title with no number a guest could text back. It comes out before the model reads the
 * title, because no check on a finished draft can tell a host's words from a short code
 * they typed to reach their guests.
 */
export function withoutTextBackNumbers(title: string): string {
  return cutNumbers(title, LONG_NUMBER_IN_TITLE, () => false);
}

/**
 * The same for a place, which keeps a street number and a full phone number. A ZIP code
 * goes, because a guest does not need it in a text.
 */
export function placeWithoutTextBackNumbers(place: string): string {
  const handed = new Set(numbersAPlaceMayHold(place).map((number) => number.index));
  return cutNumbers(place, LONG_NUMBER_IN_PLACE, (at) => handed.has(at));
}

/** A fact of digits alone exempts nothing: it cannot be told from a number to text back. */
function factsIn(line: PartyGuestLine): string[] {
  return (line.where === null ? [line.title] : [line.title, line.where])
    .map(inShape)
    .filter((fact) => LETTER.test(fact));
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
 * The draft on its `inShape` form, less ONE whole-word mention each of the title and place:
 * a place called "STOP" must not exempt a second STOP in the same text.
 */
function outsideFacts(body: string, line: PartyGuestLine): string {
  return factsIn(line).reduce(lessOneMention, inShape(body));
}

/** The party's own time, once, unless it runs on into more digits: "2:00" but not "2:00:55". */
function lessPartyClock(text: string, when: string): string {
  const match = WHEN_CLOCK.exec(inShape(when));
  if (match === null) return text;
  const [, hour, minutes, half] = match;
  const hour24 = (Number(hour) % 12) + (half === 'P' ? 12 : 0);
  const clock = `(?<!\\p{Nd})(?:${hour}|${hour24}):${minutes}(?![^\\p{L}\\p{N}\\n]*\\p{Nd})`;
  return text.replace(new RegExp(clock, 'u'), '\n');
}

/**
 * Whether the draft holds a long number the party did not give it. Only the place's street
 * and phone numbers and the party's own time are given, and each covers one mention.
 */
function holdsTextBackNumber(body: string, line: PartyGuestLine): boolean {
  const handed =
    line.where === null ? [] : numbersAPlaceMayHold(inShape(line.where)).map(([number]) => number);
  const rest = handed.reduce(lessOneMention, inShape(body));
  return LONG_NUMBER.test(lessPartyClock(rest, line.when));
}

/**
 * Whether the draft shouts a word the party's facts do not hold. A keyword to text back is
 * written in capitals in every language, so this needs no list of keywords. The time's PM
 * is a fact. A lowercase keyword is the skill's and the eval's to catch.
 */
function shoutsOutsideFacts(outside: string, when: string): boolean {
  const timeWords = new Set(inShape(when).match(SHOUTED_WORD));
  return (outside.match(SHOUTED_WORD) ?? []).some((word) => !timeWords.has(word));
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
  if (line.title.length === 0) return null;
  const outside = outsideFacts(body, line);
  if (line.why === 'asked_for_reminder') {
    if (line.where !== null && !carriesPlace(body, line.where)) return null;
    if (!carriesClock(outside, line.when)) return null;
  }
  if (contactsOutside(body, line.where === null ? [] : [line.where]).length > 0) return null;
  if (holdsTextBackNumber(body, line)) return null;
  if (namesKeyword(body, factsIn(line)) !== null) return null;
  return shoutsOutsideFacts(outside, line.when) ? null : body;
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
