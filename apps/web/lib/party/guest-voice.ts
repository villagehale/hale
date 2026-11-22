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
const TRAILING_PUNCTUATION = /[\s.,;:!?]/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const SHOUTED_WORD = /(?<![\p{L}\p{N}])\p{Lu}{2,}(?![\p{L}\p{N}])/gu;
/**
 * Five digits in a draft with only spaces or punctuation between them: more than a day or
 * a time needs, so it can be a number to text back. `\n` marks a number already lifted.
 */
const LONG_NUMBER = /\p{Nd}(?:[^\p{L}\p{N}\n]*\p{Nd}){4}/u;
/**
 * A number to text back as one word of a title or place: five or more digits joined only by
 * punctuation, as in "55-555". A space ends it, because an address puts numbers side by
 * side: "1632 14 Ave NW".
 */
const LONG_NUMBER_IN_FACT = /\p{Nd}(?:[^\p{L}\p{N}\s]*\p{Nd}){4,}/gu;
/** A phone in its usual groups, which spaces do not end: "416 555 0199", "(416) 555-0199". */
const PHONE_IN_FACT =
  /(?<!\p{Nd})(?:\+?1[\s.-]?)?\(?\p{Nd}{3}\)?[\s.-]?\p{Nd}{3}[\s.-]?\p{Nd}{4}(?!\p{Nd})/gu;
/** Opens the place, with the street next: "12-345 Main St", "13450 102 Ave". */
const STREET_NUMBER = /^\p{Nd}+(?:-\p{Nd}+)?(?=,?\s+[\p{L}\p{N}])/u;
const STREET_NUMBER_MAX_DIGITS = 6;
const CUT_EDGE = /[\s,;:(+/-]/;
/** The clock `partyWhen` ends on: "2:30 PM". */
const WHEN_CLOCK = /(\d{1,2}):(\d{2}) ([AP])M$/;
/** The day `partyWhen` puts before its clock: "December 12 at". */
const WHEN_DAY = /(\d{1,2}) at /;

/** Walks back one character at a time, because a `+$` pattern rescans a long run. */
function withoutTrailing(text: string, edge: RegExp): string {
  let end = text.length;
  while (end > 0 && edge.test(text.charAt(end - 1))) end -= 1;
  return text.slice(0, end);
}

function cutNumbers(
  fact: string,
  numbers: RegExp,
  keeps: (run: string, at: number) => boolean,
): string {
  const cut = fact
    .replace(PHONE_IN_FACT, ' ')
    .replace(numbers, (run: string, at: number) => (keeps(run, at) ? run : ' '));
  if (cut === fact) return fact;
  const tidied = withoutTrailing(
    cut
      .replace(/\s+/g, ' ')
      .replace(/ ([,.;:!?])/g, '$1')
      .replace(/^[\s,;:-]+/, ''),
    CUT_EDGE,
  );
  return WORD_CHARACTER.test(tidied) ? tidied : '';
}

/**
 * A title with no number a guest could text back. It comes out before the model reads the
 * title, because no check on a finished draft can tell a host's words from a short code
 * they typed to reach their guests.
 */
export function withoutTextBackNumbers(title: string): string {
  return cutNumbers(title, LONG_NUMBER_IN_FACT, () => false);
}

/**
 * The same for a place, which keeps only a street number that opens it. A ZIP code and a
 * phone number go, because a guest does not need them in a text.
 */
export function placeWithoutTextBackNumbers(place: string): string {
  const opening = STREET_NUMBER.exec(place)?.[0];
  const street =
    opening !== undefined &&
    Array.from(opening.matchAll(/\p{Nd}/gu)).length <= STREET_NUMBER_MAX_DIGITS
      ? opening
      : null;
  return cutNumbers(place, LONG_NUMBER_IN_FACT, (run, at) => at === 0 && run === street);
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

/**
 * The party's own time, once, when no other digit runs into it: "2:00" but not "2:00:55" or
 * "55 2:00". Its own day may stand right before it, as in "December 12, 2:00 PM".
 */
function lessPartyClock(text: string, when: string): string {
  const shaped = inShape(when);
  const match = WHEN_CLOCK.exec(shaped);
  if (match === null) return text;
  const [, hour, minutes, half] = match;
  const hour24 = (Number(hour) % 12) + (half === 'P' ? 12 : 0);
  const day = WHEN_DAY.exec(shaped)?.[1];
  const ownDay = day === undefined ? '' : `(?:${day}[^\\p{L}\\p{N}\\n]*)?`;
  const clock = `(?<!\\p{Nd}[^\\p{L}\\p{N}\\n]*)${ownDay}(?:${hour}|${hour24}):${minutes}(?![^\\p{L}\\p{N}\\n]*\\p{Nd})`;
  return text.replace(new RegExp(clock, 'u'), '\n');
}

/**
 * Whether the draft holds a long number the party did not give it. One whole mention each
 * of the title and place, with their long numbers cut, and the party's own time are given.
 */
function holdsTextBackNumber(body: string, line: PartyGuestLine): boolean {
  const title = withoutTextBackNumbers(inShape(line.title));
  const place = line.where === null ? '' : placeWithoutTextBackNumbers(inShape(line.where));
  const rest = [title, place]
    .map((fact) => withoutTrailing(fact, TRAILING_PUNCTUATION))
    .filter((fact) => LETTER.test(fact))
    .reduce(lessOneMention, inShape(body));
  return LONG_NUMBER.test(lessPartyClock(rest, line.when));
}

/**
 * Whether the draft shouts a word more often than the party's facts hold it. A keyword to
 * text back is written in capitals in every language, so this needs no list of keywords.
 * The time's PM is a fact. A lowercase keyword is the skill's and the eval's to catch.
 */
function shoutsOutsideFacts(body: string, line: PartyGuestLine): boolean {
  const timeWords = new Set(inShape(line.when).match(SHOUTED_WORD));
  const held = factsIn(line).flatMap((fact) => fact.match(SHOUTED_WORD) ?? []);
  for (const word of inShape(body).match(SHOUTED_WORD) ?? []) {
    if (timeWords.has(word)) continue;
    const at = held.indexOf(word);
    if (at === -1) return true;
    held.splice(at, 1);
  }
  return false;
}

function carriesPlace(body: string, where: string): boolean {
  const place = withoutTrailing(inShape(where).toLowerCase(), TRAILING_PUNCTUATION);
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
  const hourMark = `(?<!\\d)${hour24}\\s?h`;
  const marker = (letter: string) => `\\s?${letter}(?:\\.\\s?)?m\\b`;
  const notWrongHalf = `(?!${marker(half === 'P' ? 'a' : 'p')})`;
  const clock =
    minutes === '00'
      ? `${hours}(?::00(?!\\d)${notWrongHalf}|${marker(half as string)})|${hourMark}(?!\\s?(?:[1-5]\\d|0[1-9]))`
      : `${hours}\\s?:\\s?${minutes}(?!\\d)${notWrongHalf}|${hourMark}\\s?${minutes}(?!\\d)`;
  return new RegExp(clock, 'i').test(outside);
}

/**
 * The text as it may be sent, or null. It must say it is from Hale, because the guest has
 * no idea whose number this is. A reminder must carry the place the host typed and the
 * party's time. Only the place may carry a link or an email: a title is the host's
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
