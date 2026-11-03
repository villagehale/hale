import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { CHANNEL_SIGNIN_TTL_MS } from '~/lib/auth/channel-signin';
import { connectorNoun } from '~/lib/channel/connect/copy';
import { GOOGLE_UNVERIFIED_APP_FACT } from '~/lib/channel/connect/text-connect';
import { type CrisisRegion, crisisFactsForRegion } from '~/lib/channel/crisis-resources';
import { type ReplyLanguage, certainLanguageHint } from '~/lib/channel/language';
import { loadCronSkill } from '~/lib/cron/skill';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import { forceToolJson } from '~/lib/pipeline/structured';
import { type ConveyFact, judgeSaidLineConvey } from './said-line-convey';

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
  /** One connect link for the one Google service they asked for. */
  | 'connector_link'
  /** A co-parent in the family group chat, offered their own Google connect link. */
  | 'group_connect_ask'
  /** They asked for a date the official page has not posted. */
  | 'not_posted'
  /** They asked for a current fact search could not ground. */
  | 'no_source'
  /** A caregiver venting: warm, not a clinician, no method, no diagnosis. */
  | 'cheer_up'
  /** Someone is hurt or ill (not a crisis): Health811 and 911, never advice. */
  | 'health'
  /** A parent said yes to one village introduction. */
  | 'intro_yes'
  /** Any other answer about introductions, or the soft close (VIL-450). `facts.situation`
   * says what is true; the model words it. */
  | 'intro_reply'
  /** VIL-505: the line riding Hale's contact card (vCard MMS) at intake. */
  | 'contact_card';

export type SaidLineFact =
  | string
  | number
  | null
  | readonly string[]
  | { readonly [part: string]: string | readonly string[] };

export interface SaidLineInput {
  purpose: SaidLinePurpose;
  language: ReplyLanguage | null;
  /** The parent's own words, when the line answers a text. */
  parentWords?: string | null;
  /**
   * The parent's latest texts, oldest first, when the line answers none of them (a
   * proactive line such as the intro soft close). Read for the reply's LANGUAGE only;
   * the model never quotes or answers them. The language is inferred, never defaulted.
   */
  recentParentWords?: readonly string[] | null;
  /** Plain values, or a small structured fact (a list, or named parts) the model words itself. */
  facts: Record<string, SaidLineFact>;
  /** Strings that must appear verbatim (numbers, addresses). Never a URL: see links. */
  mustInclude?: readonly string[];
  /**
   * Fact KEYS whose meaning the text must carry, in the model's own words and language.
   * The key must name a fact (structural, in {@link acceptSaidLine}). Whether the
   * text carries that meaning is a judge, not a word list (VIL-530). A miss, or a
   * judge that does not run, sends nothing. The draft is never rewritten.
   */
  mustConvey?: readonly string[];
  /**
   * Links by slot name. The model never sees or types a URL (#868): it writes the
   * placeholder `[[name]]` where each link goes, and code puts the exact URL in.
   */
  links?: Readonly<Record<string, string>>;
}

/** The placeholder the model writes for a link slot. */
export function linkSlot(name: string): string {
  return `[[${name}]]`;
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
    // A hint only when certain; the parent's words decide the reply's language (#868).
    languageHint: certainLanguageHint(input.language),
    parentWords: input.parentWords ?? null,
    // Sent only when present, so every existing line's payload (and its cached evals)
    // is byte-for-byte unchanged.
    ...(input.recentParentWords && input.recentParentWords.length > 0
      ? { recentParentWords: input.recentParentWords }
      : {}),
    facts: input.facts,
    mustInclude: input.mustInclude ?? [],
    // Sent only when present, so every other line's payload (and cache key) is unchanged.
    ...(input.mustConvey && input.mustConvey.length > 0 ? { mustConvey: input.mustConvey } : {}),
    linkSlots: Object.keys(input.links ?? {}).map(linkSlot),
  });
}

/**
 * Structural checks only: non-empty, every required fact verbatim, each link slot
 * exactly once, and no URL typed by the model at all. Then code fills the slots
 * with the exact URLs, so a link can never be mistyped (#868).
 */
export function acceptSaidLine(text: string, input: SaidLineInput): string | null {
  let body = text.trim();
  if (body.length === 0) return null;
  const required = input.mustInclude ?? [];
  if (!required.every((fact) => body.includes(fact))) return null;
  // A mustConvey key with no fact behind it is a wiring bug, not something to say.
  // The meaning itself is not matched here. The writer asks the convey judge.
  if (!(input.mustConvey ?? []).every((key) => key in input.facts)) return null;
  if (/https?:\/\//i.test(body) || /\bwww\./i.test(body)) return null;
  for (const [name, url] of Object.entries(input.links ?? {})) {
    const slot = linkSlot(name);
    if (body.split(slot).length !== 2) return null;
    body = body.replace(slot, url);
  }
  if (/\[\[[^\]]*\]\]/.test(body)) return null;
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
          return null;
        }
        // VIL-530 (Sloane): when meanings are required, a judge reads the outbound
        // text. A miss or a judge that does not run sends nothing. The text that
        // passed is returned as written, or not at all. It is never rewritten.
        const required = conveyFacts(input);
        if (required === null) {
          console.error(
            { purpose: input.purpose },
            'said line: mustConvey fact missing - nothing sent',
          );
          return null;
        }
        if (required.length === 0) return accepted;
        const gate = await judgeSaidLineConvey(() => client, accepted, required);
        if (gate.verdict !== 'send') {
          console.error(
            {
              purpose: input.purpose,
              reason: gate.verdict === 'omit' ? 'must_convey' : gate.reason,
            },
            'said line: required meaning not conveyed - nothing sent',
          );
          return null;
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

/**
 * One text carrying one connect link, in the model's words (#868: the fixed
 * single-provider offer is gone). The link is the required fact; the unverified-app
 * caution rides as a fact the model must convey. Null: the caller sends nothing.
 */
export async function writeConnectorLink(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; provider: ConnectorProvider; url: string },
): Promise<string | null> {
  if (!writer) {
    console.error('connector link: no line writer - nothing sent');
    return null;
  }
  const service = await connectorNoun(input.language, input.provider);
  if (!service) return null;
  return writer.write({
    purpose: 'connector_link',
    language: input.language,
    facts: {
      service,
      link: linkSlot('link'),
      minutesValid: LINK_MINUTES,
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { link: input.url },
  });
}

/**
 * The group chat's connect ask, in the model's words: who it is for, what connecting
 * does, that the link is theirs alone and optional, and the unverified-app caution as
 * a fact. Code puts the URL in the slot. Null: the caller sends nothing.
 */
export async function writeGroupConnectAsk(
  writer: SaidLineWriter | null | undefined,
  input: { language: ReplyLanguage | null; provider: 'gcal' | 'gmail'; name: string; url: string },
): Promise<string | null> {
  if (!writer) {
    console.error('group connect ask: no line writer - nothing sent');
    return null;
  }
  const gmail = input.provider === 'gmail';
  const service = await connectorNoun(input.language, input.provider);
  if (!service) return null;
  return writer.write({
    purpose: 'group_connect_ask',
    language: input.language,
    facts: {
      name: input.name,
      service,
      why: gmail
        ? 'Hale would catch school and camp emails for them too'
        : "their calendar joins the kids' year Hale keeps for the family",
      linkIsTheirs: 'the link is only for this parent, not the rest of the group',
      minutesValid: LINK_MINUTES,
      inboxPrivate: gmail ? 'nothing from their inbox is shown in the group chat' : null,
      link: linkSlot('link'),
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { link: input.url },
  });
}

export type CrisisKind = 'emergency' | 'mental';

/** 988 on a mental-health crisis, 911 on a physical emergency. Presence only. */
export function crisisMustInclude(kind: CrisisKind): readonly ['988'] | readonly ['911'] {
  return kind === 'emergency' ? ['911'] : ['988'];
}

const CRISIS_DIGIT_SEPARATOR = String.raw`[\s\p{Z}\p{Pd}.\u00b7\u2022\u30fb/_]`;

// NFKC leaves these decimal digits alone, so a reply in Arabic or Hindi script would
// not carry its 988 or 911.
const NATIVE_DIGIT_ZEROS = [0x0660, 0x06f0, 0x0966] as const;

// NFKC folds full-width and other compatibility digits to ASCII, and the native
// digits above are folded by hand.
function asciiCrisisDigits(text: string): string {
  return text.normalize('NFKC').replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f]/gu, (d) => {
    const code = d.codePointAt(0) as number;
    const zero = NATIVE_DIGIT_ZEROS.find((z) => code >= z && code <= z + 9) as number;
    return String(code - zero);
  });
}

// Then any run of whitespace or separators between digits is dropped, so '9 8 8',
// '9-8-8', '9.8.8', '９８８' and '٩٨٨' all read as 988.
function foldCrisisDigits(text: string): string {
  return asciiCrisisDigits(text).replace(
    new RegExp(`(?<=\\d)${CRISIS_DIGIT_SEPARATOR}+(?=\\d)`, 'gu'),
    '',
  );
}

// The hours a line may be followed by. Any other digit after a separator run makes
// a longer number.
const CRISIS_HOURS_AFTER_NUMBER = [
  '24/7',
  '24 h',
  '24h',
  '24 hours',
  '24 heures',
  '24 horas',
  '24小时',
  '全天',
];

// Separators count only inside the number. Bounded on both sides: Room 49881, 1988,
// 988-555-0100 and 988 555 0100 are not the line, while '988 24/7' is.
function crisisNumberPattern(digits: string): RegExp {
  const sep = CRISIS_DIGIT_SEPARATOR;
  const body = [...digits].join(`${sep}*`);
  const hours = CRISIS_HOURS_AFTER_NUMBER.join('|');
  return new RegExp(`(?<!\\d${sep}*)${body}(?:(?=[\\s\\p{Z}]+(?:${hours}))|(?!${sep}*\\d))`, 'iu');
}

export function crisisTextHasRequiredNumber(kind: CrisisKind, text: string): boolean {
  const ascii = asciiCrisisDigits(text);
  return crisisMustInclude(kind).every((digits) => crisisNumberPattern(digits).test(ascii));
}

/** 988 and the Canadian spelling 9-8-8 are the same line. A physical emergency may not carry it. */
export function crisisTextHas988(text: string): boolean {
  return foldCrisisDigits(text).includes('988');
}

/**
 * Emergency replies are 911 only: the required digit is present and the 988 line is not.
 * Mental replies need 988. Presence of the required number, not a wording judge.
 */
export function crisisReplyAcceptable(kind: CrisisKind, text: string): boolean {
  if (!crisisTextHasRequiredNumber(kind, text)) return false;
  return kind === 'mental' || !crisisTextHas988(text);
}

/**
 * The opt-out reader's crisis text, or the said-line writer when that text
 * cannot be sent. The reader saw the mental facts. A physical emergency is
 * narrowed here: 911 only, so a reply that also carries 988 is handed to
 * {@link writeCrisisLine}, which is given 911-only facts. Null when neither
 * can be sent: the writer pages #ops, and a writer reply that still misses
 * the check pages here. No fixed line.
 */
export async function deliverCrisisReply(input: {
  kind: CrisisKind;
  readerText: string;
  parentWords: string;
  where: string;
  region: CrisisRegion | null;
  writer: SaidLineWriter | null | undefined;
}): Promise<string | null> {
  const fromReader = input.readerText.trim();
  if (fromReader.length > 0 && crisisReplyAcceptable(input.kind, fromReader)) {
    return fromReader;
  }
  const written = await writeCrisisLine(
    input.writer,
    input.kind,
    input.parentWords,
    input.where,
    input.region,
  );
  if (written && crisisReplyAcceptable(input.kind, written)) return written;
  if (written) logCrisisUnanswered(input.kind, input.where);
  return null;
}

/**
 * A crisis was flagged and no reply goes out (#868: there is no fixed crisis line to
 * fall back on, anywhere). Never silent: an urgent, body-free log for #ops (rule #1).
 */
export function logCrisisUnanswered(kind: CrisisKind, where: string): void {
  console.error(
    { urgent: true, kind, where },
    'URGENT: crisis flagged, no reply sent - page #ops now',
  );
}

/**
 * The crisis reply in the model's words; the numbers are the checked facts. Null after
 * the urgent log when nothing could be written: the caller sends nothing.
 */
export async function writeCrisisLine(
  writer: SaidLineWriter | null | undefined,
  kind: CrisisKind,
  parentWords: string,
  where: string,
  region: CrisisRegion | null,
): Promise<string | null> {
  const facts: Record<string, SaidLineFact> = {
    ...crisisFactsForRegion(region, kind),
  };
  const written = writer
    ? await writer.write({
        purpose: kind === 'emergency' ? 'crisis_emergency' : 'crisis_mental',
        language: null,
        parentWords,
        facts,
        mustInclude: crisisMustInclude(kind),
      })
    : null;
  if (!written) logCrisisUnanswered(kind, where);
  return written;
}

function conveyFacts(input: SaidLineInput): ConveyFact[] | null {
  const facts: ConveyFact[] = [];
  for (const key of input.mustConvey ?? []) {
    const meaning = input.facts[key];
    if (meaning === undefined) return null;
    facts.push({ key, meaning });
  }
  return facts;
}

/** Minutes a connect link stays live, said by the model (CHANNEL_SIGNIN_TTL_MS). */
/** The texted link's real life: the sign-in token's TTL (channel-signin.ts). */
const LINK_MINUTES = CHANNEL_SIGNIN_TTL_MS / 60_000;

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
      calendarLink: linkSlot('calendarLink'),
      gmailLink: linkSlot('gmailLink'),
      minutesValid: LINK_MINUTES,
      why: 'so Hale can spot daycare and school notices',
      // Both links are Google connect links, and every Google connect link carries the
      // unverified-app caution, as a fact the writer puts in its own words (text-connect.ts).
      googleCaution: GOOGLE_UNVERIFIED_APP_FACT,
    },
    links: { calendarLink: input.calendarUrl, gmailLink: input.gmailUrl },
  });
}
