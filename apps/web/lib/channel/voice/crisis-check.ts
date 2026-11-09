import { CRISIS_LINE_NAMES } from '~/lib/channel/crisis-resources';
import type { ReplyLanguage } from '~/lib/channel/language';
import { hasLinkShape } from '~/lib/format/link-shape';

/**
 * The crisis acceptance checks: the digit tokenizer, the hours forms, the link and
 * script checks. A leaf module: apps/web/vitest.setup.ts loads opt-out-reader, so
 * anything imported here loads before every test file's vi.mock (said-line's imports
 * reach @hale/db and broke lib/loop/queries.test.ts's drizzle mock).
 */

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

// Format characters (zero-width space, soft hyphen, bidi marks) are invisible, so they
// neither join nor split a number. NFKC would fold the fullwidth comma into an ASCII one;
// it becomes the ideographic comma, which NFKC keeps, so a CJK phrase break stays one.
function asciiCrisisDigits(text: string): string {
  return text
    .replace(/\p{Cf}/gu, '')
    .replace(/\uff0c/g, '\u3001')
    .normalize('NFKC')
    .replace(/[^\P{Nd}0-9]/gu, (d) => String(decimalDigitValue(d)));
}

// Hours forms a crisis line may sit next to, matched after the digit fold. Their
// digits are not another number. A per-day form may be followed by a per-week form
// ('24/24 7/7'); any other two forms joined in one number token dial a code
// ('24-7-24-7' is 247247).
const CRISIS_DAY_FORMS = [
  '24 heures sur 24',
  '24 hours',
  '24 h sur 24',
  '24h sur 24',
  '24 h/24',
  '24h/24',
  '24 heures',
  '24/24',
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
];
const CRISIS_WEEK_FORMS = [
  '7 jours sur 7',
  '7 j/7',
  '7j/7',
  '7/7',
  '7 days',
  '7 días',
  '7天',
  '7 天',
  '7 أيام',
  '7 दिन',
];
const CRISIS_DAY_AND_WEEK_FORMS = ['24/7', '24-7', '24x7', '24×7'];
const CRISIS_HOURS_FORMS = [
  ...CRISIS_DAY_FORMS,
  ...CRISIS_WEEK_FORMS,
  ...CRISIS_DAY_AND_WEEK_FORMS,
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

interface HoursFormMatch {
  form: string;
  /** Where this occurrence starts, so two occurrences of one form stay two. */
  at: number;
  end: number;
}

interface CrisisDigitGroup {
  digits: string;
  /** The listed hours form this group is part of, or null. */
  hours: HoursFormMatch | null;
  /** Built from single digits only, so the next single digit joins it. */
  spelled: boolean;
  /** What sits between this group and the one before it in the token ('' when first). */
  gap: string;
}

function hoursFormAt(ascii: string, at: number): HoursFormMatch | null {
  for (const form of CRISIS_HOURS_FORMS) {
    const end = at + form.length;
    const next = ascii[end] ?? '';
    if (ascii.slice(at, end).toLowerCase() !== form || /\d/.test(next)) continue;
    if (hoursFormEndsWord(form) && /\p{L}/u.test(next)) continue;
    return { form, at, end };
  }
  return null;
}

/**
 * The ONE tokenizer. Number tokens are maximal runs of digit groups joined by anything
 * but a letter or a line break, so a number is one token whatever separates its parts.
 * A run of single digits is one group ('9-8-8' and '9,8,8' are 988).
 */
function crisisNumberTokens(text: string): CrisisDigitGroup[][] {
  const ascii = asciiCrisisDigits(text);
  const tokens: CrisisDigitGroup[][] = [];
  let current: HoursFormMatch | null = null;
  let lastEnd = 0;
  for (const match of ascii.matchAll(/\d+/g)) {
    const at = match.index;
    if (!current || at >= current.end) current = hoursFormAt(ascii, at);
    const hours = current;
    const single = match[0].length === 1 && !hours;
    const token = tokens.at(-1);
    const prev = token?.at(-1);
    const gap = ascii.slice(lastEnd, at);
    if (!token || TOKEN_BREAK.test(gap)) {
      tokens.push([{ digits: match[0], hours, spelled: single, gap: '' }]);
    } else if (single && prev?.spelled) {
      prev.digits += match[0];
    } else {
      token.push({ digits: match[0], hours, spelled: single, gap });
    }
    lastEnd = at + match[0].length;
  }
  return tokens;
}

/** One hours form, or a per-day form then a per-week form; never more. */
function tokenHoursFormsStandAlone(token: readonly CrisisDigitGroup[]): boolean {
  const forms = [...new Set(token.map((group) => group.hours).filter((hours) => hours !== null))];
  if (forms.length !== 2) return forms.length <= 1;
  const [day, week] = forms as [HoursFormMatch, HoursFormMatch];
  return CRISIS_DAY_FORMS.includes(day.form) && CRISIS_WEEK_FORMS.includes(week.form);
}

// An allow-list: a space, a bracket or an ideographic comma between a line and an hours
// form keeps them a phrase. Any other joiner ('988-24/7', '988.24/7', '988,24/7') makes
// one dialable code.
const PHRASE_GAP = /[\s\p{Ps}\p{Pe}\u3001]/u;

/** A crisis line and an hours form written as one code, in either order. */
function tokenGluesLineToHours(token: readonly CrisisDigitGroup[]): boolean {
  return token.some((group, i) => {
    const before = token[i - 1];
    if (!before || PHRASE_GAP.test(group.gap)) return false;
    return Boolean(before.hours) !== Boolean(group.hours);
  });
}

function tokenIsCrisisLinesOnly(token: readonly CrisisDigitGroup[]): boolean {
  return (
    token.every((group) => group.hours || CRISIS_LINES.includes(group.digits)) &&
    tokenHoursFormsStandAlone(token) &&
    !tokenGluesLineToHours(token)
  );
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
export function replyLocale(language: ReplyLanguage | null): Intl.Locale | null {
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

// A line's name as its letters, joined by anything that is not one ('Suicide & Crisis'
// and 'Suicide Crisis'). The writer is handed the name in English, so a reply in any
// language may carry it; it counts for neither script. The names are Latin, so only a
// Latin letter continues the word: Han or Arabic written straight after it does not.
const CRISIS_LINE_NAME = new RegExp(
  CRISIS_LINE_NAMES.map(
    (name) =>
      `(?<!\\p{Script=Latin})${[...name.matchAll(/\p{L}+/gu)].map(([word]) => word).join('\\P{L}+')}(?!\\p{Script=Latin})`,
  ).join('|'),
  'giu',
);

const SCRIPTLESS_LETTER = /[\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Most of the reply's letters are in the script: counted after format characters go and
 * NFKC folds full-width forms, with the line names left out (numbers are not letters).
 * One native word in an English reply is not enough, and a reply with no letters but the
 * name is in no language. It tells writing systems apart; it cannot tell one language of
 * a script from another (fr, es and en are all Latin), so for those the language rests
 * on the writer's replyLanguage fact and the crisis-reply eval. Only \p{L} is counted, so
 * the vowel signs of Devanagari, Tamil or Thai (\p{M}) are not, and a dense script such
 * as Han has one letter where Latin has a word: both lean toward refusing a reply that
 * mixes in English, never toward passing one.
 */
function replyMostlyInScript(text: string, scriptLetter: RegExp): boolean {
  const folded = text
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .replace(CRISIS_LINE_NAME, ' ');
  let inScript = 0;
  let otherScript = 0;
  for (const [letter] of folded.matchAll(/\p{L}/gu)) {
    if (scriptLetter.test(letter)) inScript += 1;
    else if (!SCRIPTLESS_LETTER.test(letter)) otherScript += 1;
  }
  return inScript > otherScript;
}

export type CrisisViolation =
  | 'missing_line'
  | 'emergency_988'
  | 'other_number'
  | 'link'
  | 'wrong_script';

/**
 * The one acceptance check for every crisis reply: the required line is present, an
 * emergency carries no 988, no other number appears, no link, and the reply is mostly
 * in its language's script (a mojibake or wrong-script draft is not sent; see
 * replyMostlyInScript for what that can and cannot prove). Null: it may be sent.
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
  if (hasLinkShape(text)) return 'link';
  const scriptLetter = replyScriptLetter(language);
  if (scriptLetter && !replyMostlyInScript(text, scriptLetter)) return 'wrong_script';
  return null;
}

/**
 * A stop or start confirmation the reader wrote. Its job is to say stop or start, so any
 * number in it (an hours form too) or link is refused. Null: it may be sent.
 */
export function readerConfirmationViolation(text: string): 'other_number' | 'link' | null {
  if (crisisNumberTokens(text).length > 0) return 'other_number';
  if (hasLinkShape(text)) return 'link';
  return null;
}
