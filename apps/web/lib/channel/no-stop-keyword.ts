import { isEnabled } from '@hale/flags';
import { inShape } from '@hale/types';

/**
 * VIL-744 · Hale names no reply keyword. With NO_STOP_KEYWORD_COPY_ENABLED exactly `true`,
 * the group onboarding lines and the coach's answer to doubt say that the person can tell
 * Hale to stop in their own words, and the two app pages say the same. Off, every prompt
 * and page keeps today's bytes.
 *
 * A person stops or restarts Hale in any wording: the opt-out reader in the intake machine
 * reads the meaning. {@link namesKeyword} reads only Hale's OWN draft, never what a person
 * wrote.
 */
export function noStopKeywordCopyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('no-stop-keyword-copy', undefined, env);
}

const wordSet = (list: string): ReadonlySet<string> => new Set(list.split(' '));

const KEYWORDS = wordSet('stop start help arret aide unsubscribe');

/** How a draft tells someone what to send, in English and French. */
const SEND_VERBS = wordSet(
  'reply replying respond responding text texting send sending type typing write writing ' +
    'say saying says message enter opt repondez repondre reponds repondant textez texte ' +
    'texter textant envoyez envoie envoyer envoyant ecrivez ecris ecrire ecrivant tapez tape ' +
    'taper tapant dites dis dire disant',
);

/**
 * "Tell me stop" hands over a word, unless a determiner makes it a noun: "tell me the start
 * date". Apart from the send verbs because "tell" is the verb the way out itself uses.
 */
const TELL_VERBS = wordSet('tell telling');
const DETERMINERS = wordSet('the a an this any');

/** Words that present the next one as a word to use: "the word stop", "le mot arrêt". */
const NAMING_WORDS = wordSet('word keyword mot cle');

/** Words that can stand between a send verb or naming word and the word it points at. */
const SEND_LEADS = wordSet(
  'back with the a an this to of out is here me us hale just simply only in moi nous le ' +
    'un une ce cet cette est ici texto sms avec par simplement seulement juste ' +
    'anytime any time at whenever always now later right away again ' +
    'tout moment instant n importe quand quel toujours maintenant ' +
    'quick simple single petit thread chat fil',
);

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
/** What can sit inside a closing quote: American "stop." and French « stop ! ». */
const BEFORE_CLOSING_QUOTE = /^[\s.,!?;:\u2026]+/;

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
  const after = line.slice(end).replace(BEFORE_CLOSING_QUOTE, '').charAt(0);
  return after !== '' && QUOTE_PAIRS[before] === after;
}

/**
 * Whether a send verb or a naming word points at this word in its own sentence, through
 * lead-in words only. A bare "to" right before it is an infinitive ("tell me to stop"),
 * which is a sentence and not a keyword.
 */
function isSendInstruction(line: string, earlier: readonly DraftWord[], word: DraftWord): boolean {
  const nearest = earlier.at(-1)?.plain;
  const afterDeterminer = nearest !== undefined && DETERMINERS.has(nearest);
  let next = word;
  for (const candidate of [...earlier].reverse()) {
    if (SENTENCE_END.test(line.slice(candidate.end, next.start))) return false;
    if (SEND_VERBS.has(candidate.plain) || NAMING_WORDS.has(candidate.plain)) return true;
    if (candidate.plain === 'to' && next === word) return false;
    if (TELL_VERBS.has(candidate.plain)) return !afterDeterminer;
    if (!SEND_LEADS.has(candidate.plain)) return false;
    next = candidate;
  }
  return false;
}

/**
 * The keyword a draft would teach, in capitals, or null. A keyword counts when it is
 * shouted, quoted, or the word a send verb or naming word points at, in any case or width.
 * A false positive costs one re-draft.
 *
 * `factPieces` are the facts' own words (a name the line must carry), so a shouted or
 * quoted word inside one is not the draft teaching it. A piece can still BE an instruction:
 * the send-verb pass reads the whole text.
 */
export function namesKeyword(text: string, factPieces: readonly string[] = []): string | null {
  const outside = factPieces.reduce(
    (rest, piece) => (piece.length > 0 ? rest.split(piece).join('\n') : rest),
    text,
  );
  for (const { line, words } of draftLines(outside)) {
    for (const word of words) {
      if (KEYWORDS.has(word.plain) && (isShouted(word) || isQuoted(line, word))) {
        return word.plain.toUpperCase();
      }
    }
  }
  for (const { line, words } of draftLines(text)) {
    for (const [index, word] of words.entries()) {
      if (KEYWORDS.has(word.plain) && isSendInstruction(line, words.slice(0, index), word)) {
        return word.plain.toUpperCase();
      }
    }
  }
  return null;
}
