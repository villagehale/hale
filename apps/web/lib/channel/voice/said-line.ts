import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import { CHANNEL_SIGNIN_TTL_MS } from '~/lib/auth/channel-signin';
import { connectorNoun } from '~/lib/channel/connect/copy';
import { GOOGLE_UNVERIFIED_APP_FACT } from '~/lib/channel/connect/text-connect';
import {
  type CrisisRegion,
  type CrisisSituation,
  crisisFactsForRegion,
} from '~/lib/channel/crisis-resources';
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

/** The writer's tool schema, imported by the crisis-reply eval. */
export const SAID_LINE_TOOL_SCHEMA = outputJsonSchema;

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

/** 988 on a mental-health crisis, 911 on a physical emergency: the line the reply must carry. */
export function crisisMustInclude(kind: CrisisKind): readonly ['988'] | readonly ['911'] {
  return kind === 'emergency' ? ['911'] : ['988'];
}

// NFKC leaves native-script decimal digits (Arabic-Indic, Devanagari, Bengali, Thai...)
// alone, so a reply in those scripts would not carry its 988 or 911. Unicode encodes
// every decimal digit in a contiguous 0-9 run, so a digit's value is its distance from
// the start of its run.
function decimalDigitValue(digit: string): number {
  let zero = digit.codePointAt(0) as number;
  while (/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return ((digit.codePointAt(0) as number) - zero) % 10;
}

function asciiCrisisDigits(text: string): string {
  return text.normalize('NFKC').replace(/[^\P{Nd}0-9]/gu, (d) => String(decimalDigitValue(d)));
}

// Hours forms a crisis line may sit next to, matched after the digit fold. Their
// digits are not another number.
const CRISIS_HOURS_FORMS = [
  '24 heures sur 24',
  '24 hours',
  '24 h sur 24',
  '24h sur 24',
  '24 h/24',
  '24h/24',
  '24 heures',
  '7 jours sur 7',
  '7 j/7',
  '7j/7',
  '24/24',
  '7/7',
  '24/7',
  '24-7',
  '24x7',
  '24×7',
  '24 hrs',
  '24hrs',
  '24 horas',
  '24 h',
  '24h',
  '24小时',
  '24 小时',
  '24小時',
  '24 小時',
  '24 ساعة',
  '24 घंटे',
  '7 days',
  '7 días',
  '7天',
  '7 天',
  '7 أيام',
  '7 दिन',
].sort((a, b) => b.length - a.length);

// A form ending in a letter ends at a word boundary ('24 h' is not '24 hommes'). Han
// has no spaces between words, so a form ending in Han does not.
function hoursFormEndsWord(form: string): boolean {
  const last = form.at(-1) ?? '';
  return /\p{L}/u.test(last) && !/\p{Script=Han}/u.test(last);
}

const CRISIS_LINES: readonly string[] = [
  ...crisisMustInclude('mental'),
  ...crisisMustInclude('emergency'),
];

const TOKEN_BREAK = /[\p{L}\n\r\v\f\u0085\u2028\u2029]/u;

interface CrisisDigitGroup {
  digits: string;
  /** Part of a listed hours form. */
  hours: boolean;
  /** Built from single digits only, so the next single digit joins it. */
  spelled: boolean;
}

function hoursFormEnd(ascii: string, at: number): number {
  for (const form of CRISIS_HOURS_FORMS) {
    const end = at + form.length;
    const next = ascii[end] ?? '';
    if (ascii.slice(at, end).toLowerCase() !== form || /\d/.test(next)) continue;
    if (hoursFormEndsWord(form) && /\p{L}/u.test(next)) continue;
    return end;
  }
  return -1;
}

/**
 * The ONE tokenizer. Number tokens are maximal runs of digit groups joined by anything
 * but a letter or a line break, so a number is one token whatever separates its parts.
 * A run of single digits is one group ('9-8-8' and '9,8,8' are 988).
 */
function crisisNumberTokens(text: string): CrisisDigitGroup[][] {
  const ascii = asciiCrisisDigits(text);
  const tokens: CrisisDigitGroup[][] = [];
  let hoursUntil = -1;
  let lastEnd = 0;
  for (const match of ascii.matchAll(/\d+/g)) {
    const at = match.index;
    if (at >= hoursUntil) hoursUntil = hoursFormEnd(ascii, at);
    const hours = at < hoursUntil;
    const single = match[0].length === 1 && !hours;
    const token = tokens.at(-1);
    const prev = token?.at(-1);
    if (!token || TOKEN_BREAK.test(ascii.slice(lastEnd, at))) {
      tokens.push([{ digits: match[0], hours, spelled: single }]);
    } else if (single && prev?.spelled) {
      prev.digits += match[0];
    } else {
      token.push({ digits: match[0], hours, spelled: single });
    }
    lastEnd = at + match[0].length;
  }
  return tokens;
}

function tokenIsCrisisLinesOnly(token: readonly CrisisDigitGroup[]): boolean {
  return token.every((group) => group.hours || CRISIS_LINES.includes(group.digits));
}

const LINK_SCHEME = /[a-z][a-z\d+.-]*:\/\/|\bwww\./i;
// A name, a dot, then a 2+ letter ending: written plainly, spaced on both sides, or
// bracketed ('example[.]com').
const DOMAIN_DOT = /[\p{L}\d-](?:\.|\s+\.\s+|\s*[[({]\s*\.\s*[\])}]\s*)\p{L}{2,}(?![\p{L}\d])/iu;
// An ideographic full stop between Latin parts ('example。com'), but not a CJK sentence end.
const IDEOGRAPHIC_DOMAIN_DOT = /[a-z\d-][\u3002\uff61][a-z]{2,}(?![a-z\d])/i;

// Not domain dots: a Spanish doubled-letter plural ('EE.UU.'), and an ASCII full stop
// ending a sentence before Chinese or Japanese when no Latin name sits before it.
const DOUBLED_PAIR_ABBREVIATION = /(?<!\p{L})(\p{Lu})\1\.(\p{Lu})\2\.(?![\p{L}\d])/gu;
const CJK_SENTENCE_DOT =
  /(?<![^\P{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][\p{Nd}-]*)\.(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/gu;

function crisisTextHasLink(text: string): boolean {
  const folded = text
    .normalize('NFKC')
    .replace(DOUBLED_PAIR_ABBREVIATION, ' ')
    .replace(CJK_SENTENCE_DOT, ' ');
  return LINK_SCHEME.test(folded) || DOMAIN_DOT.test(folded) || IDEOGRAPHIC_DOMAIN_DOT.test(folded);
}

// Intl names a language's usual script; these tags name a writing system that spans
// several Unicode scripts.
const WRITING_SYSTEM_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  Hans: ['Han'],
  Hant: ['Han'],
  Hanb: ['Han', 'Bopomofo'],
  Jpan: ['Han', 'Hiragana', 'Katakana'],
  Kore: ['Hangul', 'Han'],
};

// Languages with more than one standard script (CLDR). Intl's likely script names only
// one of them, so a correct reply in the other (Shahmukhi Punjabi, Latin Serbian) would
// read as the wrong script.
const LANGUAGE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  az: ['Latn', 'Cyrl', 'Arab'],
  bs: ['Latn', 'Cyrl'],
  ff: ['Latn', 'Adlm'],
  ha: ['Latn', 'Arab'],
  kk: ['Cyrl', 'Latn', 'Arab'],
  ks: ['Arab', 'Deva'],
  ku: ['Latn', 'Arab'],
  ky: ['Cyrl', 'Latn'],
  mn: ['Cyrl', 'Mong'],
  ms: ['Latn', 'Arab'],
  pa: ['Guru', 'Arab'],
  sd: ['Arab', 'Deva'],
  sr: ['Cyrl', 'Latn'],
  tg: ['Cyrl', 'Arab'],
  tk: ['Latn', 'Cyrl'],
  ug: ['Arab', 'Cyrl', 'Latn'],
  uz: ['Latn', 'Cyrl', 'Arab'],
};

/** The tag as an Intl locale, or null when it is not one Intl can read. */
function replyLocale(language: ReplyLanguage | null): Intl.Locale | null {
  if (!language) return null;
  try {
    return new Intl.Locale(language);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

/** A letter of a script standard for the reply language, or null when the tag names no known script. */
function replyScriptLetter(language: ReplyLanguage | null): RegExp | null {
  const locale = replyLocale(language)?.maximize();
  if (!locale?.script) return null;
  const tags = new Set([locale.script, ...(LANGUAGE_SCRIPTS[locale.language] ?? [])]);
  const scripts = [...tags].flatMap((tag) => WRITING_SYSTEM_SCRIPTS[tag] ?? [tag]);
  try {
    return new RegExp(`[${scripts.map((name) => `\\p{Script=${name}}`).join('')}]`, 'u');
  } catch (err) {
    // An ISO 15924 code the regex engine has no Unicode property for.
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

export type CrisisViolation =
  | 'missing_line'
  | 'emergency_988'
  | 'other_number'
  | 'link'
  | 'wrong_script';

/**
 * The one acceptance check for every crisis reply: the required line is present, an
 * emergency carries no 988, no other number appears, no link, and the reply has a
 * letter of its language's script (a mojibake or wrong-language draft is not sent).
 * Null: it may be sent.
 */
export function crisisReplyViolation(
  kind: CrisisKind,
  text: string,
  language: ReplyLanguage | null,
): CrisisViolation | null {
  const tokens = crisisNumberTokens(text);
  const [required] = crisisMustInclude(kind);
  const numbers = tokens.flat().filter((group) => !group.hours);
  // The line counts only in a token of crisis lines and hours (checked below), so a
  // longer number holding its digits is refused; that refusal is other_number, since
  // the line itself is there.
  if (!numbers.some((group) => group.digits === required)) return 'missing_line';
  if (kind === 'emergency' && numbers.some((group) => group.digits === '988')) {
    return 'emergency_988';
  }
  if (!tokens.every(tokenIsCrisisLinesOnly)) return 'other_number';
  if (crisisTextHasLink(text)) return 'link';
  const scriptLetter = replyScriptLetter(language);
  if (scriptLetter && !scriptLetter.test(text)) return 'wrong_script';
  return null;
}

/**
 * A stop or start confirmation the reader wrote: it is handed no number and no link, so
 * any number (hours forms aside) or link in it is refused. Null: it may be sent.
 */
export function readerConfirmationViolation(text: string): 'other_number' | 'link' | null {
  const numbers = crisisNumberTokens(text)
    .flat()
    .filter((group) => !group.hours);
  if (numbers.length > 0) return 'other_number';
  if (crisisTextHasLink(text)) return 'link';
  return null;
}

/** Why the last draft was not sent, handed back to the writer as a fact on its one re-ask. */
export const CRISIS_VIOLATION_FACT: Readonly<Record<CrisisViolation | 'write_failed', string>> = {
  write_failed: 'the last draft could not be used, so it was not sent',
  missing_line: 'the last draft did not carry the line in facts, so it was not sent',
  emergency_988: 'the last draft carried 988, and an emergency reply carries 911 only',
  other_number: 'the last draft carried a number that is not in facts, so it was not sent',
  link: 'the last draft carried a link or web address, so it was not sent',
  wrong_script: 'the last draft was not written in the reply language, so it was not sent',
};

/**
 * What the reader read happening on an emergency, as a fact. The writer never sees the
 * parent's words, so without it the reply is a generic "call 911". One fixed fact per
 * closed situation: no digits, no link, nothing from the parent's text.
 */
export const EMERGENCY_SITUATION_FACTS: Readonly<Record<CrisisSituation, string>> = {
  not_breathing:
    'they just told Hale someone is not breathing or is struggling to breathe, right now',
  choking: 'they just told Hale someone is choking right now',
  poisoning_or_overdose:
    'they just told Hale someone may have swallowed something harmful or taken too much of a medicine or drug, right now',
  injury_or_bleeding: 'they just told Hale someone is injured or bleeding right now',
  unresponsive: 'they just told Hale someone is not responding or cannot be woken, right now',
  fire: 'they just told Hale there is a fire right now',
  violence_or_threat:
    'they just told Hale someone is being hurt or threatened by another person right now',
  self_harm: 'they just told Hale someone has hurt themselves and may be in danger right now',
  other: 'they just told Hale someone is hurt or in danger right now',
};

/**
 * The reply language's name in its own language ('العربية' for ar). With only the tag,
 * the writer returned mojibake for Arabic (6 of 6 draws, 11-03); the name puts the
 * script in front of it.
 */
function replyLanguageName(language: ReplyLanguage | null): string | null {
  const locale = replyLocale(language);
  if (!locale) return null;
  const name = new Intl.DisplayNames([locale.baseName], { type: 'language', fallback: 'none' }).of(
    locale.baseName,
  );
  return name ?? null;
}

/**
 * The crisis request: facts only. The parent's words never reach the writer, so an
 * injected or invented number has no source; the reply language comes from what Hale
 * already knows or the reader's language tag.
 */
export function crisisLineInput(
  kind: CrisisKind,
  region: CrisisRegion | null,
  language: ReplyLanguage | null,
  situation: CrisisSituation | null,
  rejected?: CrisisViolation | 'write_failed',
): SaidLineInput {
  const languageName = replyLanguageName(language);
  return {
    purpose: kind === 'emergency' ? 'crisis_emergency' : 'crisis_mental',
    language,
    facts: {
      ...crisisFactsForRegion(region, kind),
      // A mental-health reply's facts are its lines; what happened changes only what an
      // emergency reply says first. No situation read is the generic emergency.
      ...(kind === 'emergency'
        ? { situation: EMERGENCY_SITUATION_FACTS[situation ?? 'other'] }
        : {}),
      ...(languageName ? { replyLanguage: languageName } : {}),
      ...(rejected ? { previousTextNotSent: CRISIS_VIOLATION_FACT[rejected] } : {}),
    },
  };
}

/** The crisis reply's language: the one Hale already holds wins, else the one the reader read. */
export function crisisReplyLanguage(
  known: ReplyLanguage | null,
  reading: { language?: ReplyLanguage | null } | null,
): ReplyLanguage | null {
  return known ?? reading?.language ?? null;
}

export type CrisisReplyOutcome =
  | { status: 'sent'; body: string; attempts: 1 | 2 }
  | { status: 'unanswered'; reason: 'no_writer' | 'write_failed' | CrisisViolation };

/**
 * Every crisis reply: the said-line writer, from facts only, through
 * {@link crisisReplyViolation}. A failed check, or a write that returned nothing (the
 * said-line structural check refused it, or the call failed), is re-asked once with the
 * reason named as a fact. A second failure, or no writer, pages #ops and sends nothing
 * (#868: there is no fixed crisis line).
 */
export async function deliverCrisisReply(input: {
  kind: CrisisKind;
  language: ReplyLanguage | null;
  region: CrisisRegion | null;
  /** What the reader read happening; null when no crisis reading named one. */
  situation: CrisisSituation | null;
  where: string;
  writer: SaidLineWriter | null | undefined;
}): Promise<CrisisReplyOutcome> {
  const { kind, region, language, situation, where, writer } = input;
  if (!writer) {
    logCrisisUnanswered(kind, where, 'no_writer');
    return { status: 'unanswered', reason: 'no_writer' };
  }
  const first = checkCrisisDraft(
    kind,
    await writer.write(crisisLineInput(kind, region, language, situation)),
    language,
  );
  if ('body' in first) return { status: 'sent', body: first.body, attempts: 1 };
  const second = checkCrisisDraft(
    kind,
    await writer.write(crisisLineInput(kind, region, language, situation, first.reason)),
    language,
  );
  if ('body' in second) return { status: 'sent', body: second.body, attempts: 2 };
  logCrisisUnanswered(kind, where, second.reason);
  return { status: 'unanswered', reason: second.reason };
}

function checkCrisisDraft(
  kind: CrisisKind,
  draft: string | null,
  language: ReplyLanguage | null,
): { body: string } | { reason: CrisisViolation | 'write_failed' } {
  if (draft === null) return { reason: 'write_failed' };
  const reason = crisisReplyViolation(kind, draft, language);
  return reason === null ? { body: draft } : { reason };
}

/**
 * A crisis was flagged and no reply goes out (#868: there is no fixed crisis line to
 * fall back on, anywhere). Never silent: an urgent, body-free log for #ops (rule #1).
 */
export function logCrisisUnanswered(kind: CrisisKind, where: string, reason: string): void {
  console.error(
    { urgent: true, kind, where, reason },
    'URGENT: crisis flagged, no reply sent - page #ops now',
  );
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
