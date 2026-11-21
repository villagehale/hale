import { inShape } from '@hale/types';
// Relative, not `~/`: run-intro-voice-eval.mjs imports this file through tsx's bare
// tsImport, which does not read the web tsconfig's path alias.
import { smsSegments } from './sms-segments';

/**
 * Outbound texts do not end with an opt-out line.
 *
 * Founder decision, 2026-10-01. Until then every proactive SMS carried one of two
 * lines — {@link OPT_OUT_LINE} on a recipient's first proactive message of a period,
 * {@link OPT_OUT_SHORT} on every message after it — because counsel read CASL
 * s.6(2)(c) and s.11 as requiring the unsubscribe mechanism in every commercial
 * electronic message. That footer is no longer appended, including on calendar
 * reminders.
 *
 * A parent who asks to stop, in any wording, is opted out by the opt-out
 * reader (#868) in the intake machine, above the router. The two strings stay in
 * this module: composers refuse a message that writes one through
 * {@link writesOptOutLine}, and the segment budgets sized against the longer line read
 * {@link OPT_OUT_LINE_CHARS}.
 *
 * {@link withOptOut} remains the single function a send uses to finish a body. It
 * returns that body unchanged. The outbound gate still names a form (`full` |
 * `short`); nothing writes that form onto the text.
 */

/** VIL-504 / Barton: never teach STOP/HELP. These strings are NOT appended and must
 * never be sent; composers refuse a draft that writes them. OTP remains the only
 * allowed fixed parent-facing copy.
 */
export const OPT_OUT_LINE = 'Reply STOP to opt out.';

/** Compact form. Same rule as {@link OPT_OUT_LINE}: ban-list only, never appended. */
export const OPT_OUT_SHORT = 'STOP to opt out.';

/**
 * The longer line's length. Several segment budgets were sized against it, and they read
 * this number rather than the line: no module outside this one imports a string that holds
 * STOP (VIL-706, `stop-help-imports.guard.test.ts`).
 */
export const OPT_OUT_LINE_CHARS = OPT_OUT_LINE.length;

/**
 * How many SMS segments `body` takes with the longer opt-out line reserved after it. The
 * nudge budget was sized against a body that carried the line; it reads this count, and
 * the line itself is never appended.
 */
export function segmentsWithOptOutReserved(body: string): number {
  return smsSegments(`${body}\n\n${OPT_OUT_LINE}`);
}

/** Whether a draft writes either opt-out line, in any case. Composers refuse one that does. */
export function writesOptOutLine(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(OPT_OUT_LINE.toLowerCase()) || lower.includes(OPT_OUT_SHORT.toLowerCase());
}

/**
 * Whether a draft carries the longer line exactly as written. The nudge composer reads
 * this and not {@link writesOptOutLine}: a draft it refuses falls back to a code-built
 * line, so a wider check there would send more of that line and needs its own flag.
 */
export function carriesExactOptOutLine(text: string): boolean {
  return text.includes(OPT_OUT_LINE);
}

/**
 * The carrier keywords, spelled plainly. All of this reads Hale's OWN outgoing text. What
 * a person writes is read for meaning by the opt-out reader (#868), never matched against
 * words (REVIEW.md).
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set(['stop', 'help', 'arret', 'aide']);

/** How a draft tells someone what to send, in English and French. */
const SEND_VERBS: ReadonlySet<string> = new Set([
  'reply',
  'replying',
  'respond',
  'responding',
  'text',
  'texting',
  'send',
  'sending',
  'type',
  'typing',
  'write',
  'writing',
  'say',
  'saying',
  'says',
  'message',
  'enter',
  'opt',
  'repondez',
  'repondre',
  'reponds',
  'repondant',
  'textez',
  'texte',
  'texter',
  'textant',
  'envoyez',
  'envoie',
  'envoyer',
  'envoyant',
  'ecrivez',
  'ecris',
  'ecrire',
  'ecrivant',
  'tapez',
  'tape',
  'taper',
  'tapant',
  'dites',
  'dis',
  'dire',
  'disant',
]);

/** Words that present the next one as a word to use: "the word stop", "le mot arrêt". */
const NAMING_WORDS: ReadonlySet<string> = new Set(['word', 'keyword', 'mot', 'cle']);

/** Words that can stand between a send verb or naming word and the word it points at. */
const SEND_LEADS: ReadonlySet<string> = new Set([
  'back',
  'with',
  'the',
  'a',
  'an',
  'this',
  'to',
  'of',
  'out',
  'is',
  'here',
  'me',
  'us',
  'just',
  'simply',
  'only',
  'in',
  'moi',
  'nous',
  'le',
  'un',
  'une',
  'ce',
  'cet',
  'cette',
  'est',
  'ici',
  'texto',
  'sms',
  'avec',
  'par',
  'simplement',
  'seulement',
  'juste',
]);

const QUOTE_PAIRS: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  '`': '`',
  '\u201c': '\u201d',
  '\u2018': '\u2019',
  '\u00ab': '\u00bb',
  '\u2039': '\u203a',
};

const DRAFT_WORD = /[\p{L}\p{N}]+/gu;
const SENTENCE_END = /[.!?;\u3002]/;
const LINE_BREAK = /[\r\n\u2028\u2029]+/;

interface DraftWord {
  written: string;
  plain: string;
  start: number;
  end: number;
}

/** Each line on the shared shape: width, accents and zero-width characters read away. */
function draftLines(text: string): Array<{ line: string; words: DraftWord[] }> {
  return text
    .split(LINE_BREAK)
    .map(inShape)
    .map((line) => ({
      line,
      words: Array.from(line.matchAll(DRAFT_WORD), (match) => ({
        written: match[0],
        plain: match[0].toLowerCase(),
        start: match.index,
        end: match.index + match[0].length,
      })),
    }));
}

/** "STOP" or "sToP": anything other than the word in lower case or with a capital first. */
function isShouted({ written, plain }: DraftWord): boolean {
  return written !== plain && written !== plain.charAt(0).toUpperCase() + plain.slice(1);
}

function isQuoted(line: string, { start, end }: DraftWord): boolean {
  const before = line.slice(0, start).trimEnd().slice(-1);
  const after = line.slice(end).trimStart().charAt(0);
  return after !== '' && QUOTE_PAIRS[before] === after;
}

/**
 * Whether a send verb or a naming word points at this word in its own sentence, through
 * lead-in words only. A bare "to" right before it is an infinitive ("text me to stop"),
 * which is a sentence and not a keyword.
 */
function isSendInstruction(line: string, earlier: readonly DraftWord[], word: DraftWord): boolean {
  let next = word;
  for (const candidate of [...earlier].reverse()) {
    if (SENTENCE_END.test(line.slice(candidate.end, next.start))) return false;
    if (SEND_VERBS.has(candidate.plain) || NAMING_WORDS.has(candidate.plain)) return true;
    if (candidate.plain === 'to' && next === word) return false;
    if (!SEND_LEADS.has(candidate.plain)) return false;
    next = candidate;
  }
  return false;
}

/**
 * VIL-706 · the keyword a draft would teach, in capitals, or null. A keyword counts when
 * it is shouted, quoted, or the word a send verb or naming word points at ("reply stop",
 * "reply to this with a stop", "you can opt out with the word help", "Répondez Arrêt"),
 * in any case or width. "Tell me if you want me to stop" is a sentence, not a keyword.
 * A false positive costs one re-draft.
 *
 * `factPieces` are the facts' own words: a place the line must carry, or a calendar title
 * it may repeat. A "BUS STOP 14" there is not the draft shouting a keyword. A piece can
 * still BE an instruction: the send-verb check reads the whole text, so "Text stop to
 * 12345" as a place is refused.
 */
export function namesOptOutKeyword(
  text: string,
  factPieces: readonly string[] = [],
): string | null {
  if (writesOptOutLine(text)) return 'opt_out_line';
  const outside = factPieces.reduce(
    (rest, piece) => (piece.length > 0 ? rest.split(piece).join('\n') : rest),
    text,
  );
  for (const { line, words } of draftLines(outside)) {
    for (const word of words) {
      if (OPT_OUT_KEYWORDS.has(word.plain) && (isShouted(word) || isQuoted(line, word))) {
        return word.plain.toUpperCase();
      }
    }
  }
  for (const { line, words } of draftLines(text)) {
    for (const [index, word] of words.entries()) {
      if (
        OPT_OUT_KEYWORDS.has(word.plain) &&
        isSendInstruction(line, words.slice(0, index), word)
      ) {
        return word.plain.toUpperCase();
      }
    }
  }
  return null;
}

/** Which form the gate would have chosen. Neither is written onto the text. */
export type OptOutForm = 'full' | 'short';

/** How often the gate used to switch from the full form back to the short one. */
export const OPT_OUT_PERIOD_DAYS = 30;

const PERIOD_MS = OPT_OUT_PERIOD_DAYS * 24 * 3_600_000;

/**
 * The start of the period `now` falls in — an epoch-anchored grid, so every recipient
 * and every surface agrees on the boundary without storing one. The gate still reads
 * it to name a form. The form is not appended.
 */
export function optOutPeriodStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS);
}

/**
 * The body a proactive send puts on the wire.
 *
 * The form argument is ignored. Callers still pass the gate's choice so the send
 * sites stay one function; the text is the composed sentence alone.
 */
export function withOptOut(body: string, _form: OptOutForm): string {
  return body;
}
