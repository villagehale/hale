/**
 * The gate in front of a model-written duty or family-memory reply.
 *
 * The model may use only the facts it was given. A failure here is not edited:
 * the caller sends the locked sentence already on main (the #738 strings).
 * Compliance replies, refused, group sync, and the recall list lines never
 * come through here. Those stay fixed.
 */

export type ReplyCopyLanguage = 'en' | 'fr';
export type ReplyCopyRole = 'prose' | 'opening' | 'closing';

export type ReplyCopyFailure =
  | 'empty'
  | 'length'
  | 'language'
  | 'banned'
  | 'question'
  | 'next_step'
  | 'digit'
  | 'place'
  | 'name'
  | 'group_memory';

export interface ReplyCopyCheck {
  language: ReplyCopyLanguage;
  /** Strings the model was allowed to reuse. Digits, names, and places must come from these. */
  facts: readonly string[];
  audience: 'direct' | 'group';
  /** Remembered values. Any of these in a group message fails, even when they are also facts. */
  sealedValues?: readonly string[];
  /** False when the ask budget already spent this bubble, or the locked line is not a question. */
  questionAllowed: boolean;
  role: ReplyCopyRole;
}

export const REPLY_COPY_MAX_CHARS = 320;

const EN_CUES = new Set([
  'the',
  'and',
  'have',
  'has',
  'here',
  'nobody',
  'tomorrow',
  'forgot',
  'say',
  'who',
  'done',
  'nothing',
  'yet',
  'what',
  'your',
  'changes',
  'taking',
  'old',
  'thing',
  'near',
  'think',
  'so',
  'if',
  'that',
]);

const FR_CUES = new Set([
  'voici',
  'pour',
  'qui',
  'demain',
  'rien',
  'personne',
  'occupe',
  'encore',
  'famille',
  'dites',
  'ici',
  'oublie',
  'est',
  'les',
  'des',
  'vous',
  'sont',
  'ca',
  'faire',
  'cest',
]);

/** Date and place words. They count even at the start of a sentence. */
const PLACE_WORDS = new Set([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'tomorrow',
  'today',
  'tonight',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
  'demain',
  'janvier',
  'fevrier',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'aout',
  'septembre',
  'octobre',
  'novembre',
  'decembre',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]);

/** Capitals a sentence is allowed to open with, or a next step is allowed to use. */
const FREE = new Set([
  'i',
  'a',
  'ok',
  'say',
  'text',
  'dites',
  'dis',
  'nothing',
  'rien',
  'who',
  'done',
  'here',
  'heres',
  'nobody',
  'wrong',
  'got',
  'still',
  'you',
  'and',
  'the',
]);

const BANNED: RegExp[] = [
  /\bbooked\b/i,
  /\benrolled\b/i,
  /\bsigned up\b/i,
  /\bregistered\b/i,
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bautomation\b/i,
  /\bAI\b/,
  /\bA\.I\.\b/,
  /[{}]/,
];

const POSTAL = /\b[A-Z]\d[A-Z](?:\s?\d[A-Z]\d)?\b/g;
const WORD = /[A-Za-z][A-Za-z'.-]*/g;

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/['’]/g, '')
      .match(/[a-z]+/g) ?? []
  );
}

function cueCount(tokens: readonly string[], cues: ReadonlySet<string>): number {
  let count = 0;
  for (const token of tokens) if (cues.has(token)) count += 1;
  return count;
}

function languageMatches(text: string, language: ReplyCopyLanguage): boolean {
  if (language === 'fr' && [...text].some((char) => char.charCodeAt(0) > 0x7f)) return false;
  const tokens = words(text);
  const en = cueCount(tokens, EN_CUES);
  const fr = cueCount(tokens, FR_CUES);
  if (language === 'fr') return fr > en && fr > 0;
  return en > fr && en > 0;
}

function sentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : [text.trim()];
}

function isNextStep(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (/^nothing to do\.$/i.test(trimmed)) return true;
  if (/^rien a faire\.$/i.test(trimmed)) return true;
  if (trimmed.endsWith('?')) return true;
  if (/^(say|text|dites|dis)\b/i.test(trimmed)) return true;
  const questions = trimmed.match(/\?/g)?.length ?? 0;
  return questions === 1 && /\b(say|text|dites|dis)\b/i.test(trimmed);
}

function endsInOneNextStep(text: string, role: ReplyCopyRole): boolean {
  if (/[\r\n]/.test(text)) return false;
  const parts = sentences(text);
  const cap = role === 'prose' ? 2 : 1;
  if (parts.length < 1 || parts.length > cap) return false;
  if (role === 'opening') return true;
  const nexts = parts.filter(isNextStep);
  if (nexts.length !== 1) return false;
  return isNextStep(parts[parts.length - 1] ?? '');
}

function stem(raw: string): string {
  return raw.replace(/'(s)?$/i, '');
}

function grounded(token: string, facts: readonly string[]): boolean {
  const needle = token.toLowerCase();
  if (!needle) return false;
  return facts.some((fact) => fact.toLowerCase().includes(needle));
}

function digitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

function sentenceStart(text: string, index: number): boolean {
  const before = text
    .slice(0, index)
    .replace(/["']+$/g, '')
    .trimEnd();
  if (before === '') return true;
  return /[.!]$/.test(before);
}

function inventedPlace(text: string, facts: readonly string[]): boolean {
  for (const match of text.matchAll(POSTAL)) {
    const code = match[0] ?? '';
    if (code && !grounded(code, facts)) return true;
  }
  for (const match of text.matchAll(WORD)) {
    const raw = match[0] ?? '';
    const token = stem(raw).toLowerCase();
    if (!PLACE_WORDS.has(token)) continue;
    if (!grounded(token, facts)) return true;
  }
  return false;
}

function inventedName(text: string, facts: readonly string[]): boolean {
  for (const match of text.matchAll(WORD)) {
    const raw = match[0] ?? '';
    if (!raw || raw[0] !== raw[0]?.toUpperCase() || raw[0] === raw[0]?.toLowerCase()) continue;
    const token = stem(raw);
    if (token.length < 2) continue;
    const lower = token.toLowerCase();
    if (PLACE_WORDS.has(lower) || FREE.has(lower)) continue;
    const index = match.index ?? 0;
    if (sentenceStart(text, index)) continue;
    if (!grounded(token, facts)) return true;
  }
  return false;
}

/**
 * Null when the text may send. Otherwise the first rule it broke, in a fixed
 * order, so a test can pin one failure at a time.
 */
export function validateReplyCopy(text: string, check: ReplyCopyCheck): ReplyCopyFailure | null {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > REPLY_COPY_MAX_CHARS) return 'length';
  if (!languageMatches(trimmed, check.language)) return 'language';
  if (BANNED.some((pattern) => pattern.test(trimmed))) return 'banned';
  const questions = trimmed.match(/\?/g)?.length ?? 0;
  if (questions > 1) return 'question';
  if (!check.questionAllowed && questions > 0) return 'question';
  if (check.role === 'opening' && questions > 0) return 'question';
  if (!endsInOneNextStep(trimmed, check.role)) return 'next_step';
  const allowedDigits = new Set(check.facts.flatMap((fact) => digitRuns(fact)));
  if (digitRuns(trimmed).some((run) => !allowedDigits.has(run))) return 'digit';
  if (inventedPlace(trimmed, check.facts)) return 'place';
  if (inventedName(trimmed, check.facts)) return 'name';
  if (check.audience === 'group') {
    for (const value of check.sealedValues ?? []) {
      const needle = value.trim();
      if (needle.length < 2) continue;
      if (trimmed.toLowerCase().includes(needle.toLowerCase())) return 'group_memory';
    }
  }
  return null;
}
