import { smsEncoding } from '~/lib/channel/sms-segments';
import { gsmSafe } from '~/lib/loop/templates/weekly-plan/core';

/**
 * The fold the rest of Hale's outbound SMS already uses (`gsmSafe`), plus the
 * spaces and dashes a mail client emits that the weekly-plan fold does not name.
 *
 * An accent the GSM-7 alphabet cannot carry becomes its base letter (ô → o,
 * ç → c). é, è, à, ù, and Ç stay, because the alphabet has them. A curly quote
 * becomes a straight one. An emoji is dropped. Nothing here deletes a letter
 * to get rid of the mark on it.
 *
 * Applied before a receipt or an alert is verified, and the line that is sent
 * is this string — never the raw model text, and never a rejection whose only
 * fault was an accent.
 */

const EXTRA_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u2212/g, '-'], // minus
  [/[\u00a0\u2009\u202f]/g, ' '], // nbsp, thin space, narrow nbsp
  [/\u2022/g, '-'], // bullet
];

export function foldOutboundLine(text: string): string {
  let prepared = text;
  for (const [pattern, replacement] of EXTRA_FOLDS)
    prepared = prepared.replace(pattern, replacement);
  return gsmSafe(prepared).replace(/\s+/g, ' ').trim();
}

/** A folded line a carrier can bill as GSM-7. Empty when the fold left nothing. */
export function foldedGsmLine(text: string): string | null {
  if (text.includes('\n') || text.includes('\r')) return null;
  const line = foldOutboundLine(text);
  if (!line) return null;
  if (smsEncoding(line) !== 'gsm7') return null;
  return line;
}

const REPLY_VERBS =
  'reply|respond|text|texte|texter|send|type|write|say|ecris|écris|dis|dites|envoie|envoyer|tape|reponds|réponds';
const REPLY_TOKENS = 'yes|no|oui|non|stop|remove|start|unstop';
/**
 * A line that tells the parent which word to send back.
 *
 * English and French verbs, and any all-caps reply token (STOP, OUI, REMOVE)
 * even with no verb in front of it. "Say if you want it off" has the verb and
 * no token, so it stays.
 */
export function asksForKeyword(line: string, allowed = ''): boolean {
  const phrase = new RegExp(
    `\\b(?:${REPLY_VERBS})\\b[^.?!]{0,40}\\b(?:${REPLY_TOKENS})\\b|\\byes to confirm\\b|\\bpour confirmer\\b`,
    'i',
  );
  if (phrase.test(line)) return true;
  const facts = foldOutboundLine(allowed);
  for (const token of line.match(/\b(?:YES|NO|OUI|NON|STOP|REMOVE|START|UNSTOP)\b/g) ?? []) {
    if (!facts.includes(token)) return true;
  }
  return false;
}

const EN_WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const FR_WEEKDAYS = [
  'dimanche',
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
] as const;

const EN_MONTH =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

const FR_MONTH =
  'janvier|fevrier|février|mars|avril|mai|juin|juillet|aout|août|septembre|octobre|novembre|decembre|décembre|janv|fevr|févr|avr|juil|sept|oct|nov|dec|déc';

export type StraySchedule = 'stray_date' | 'stray_weekday' | 'stray_clock' | 'stray_money';

/**
 * A date, weekday, clock, or amount the facts do not contain.
 *
 * Compared after the same fold as the line, so "4 oct." in a French label is
 * the date that was rendered and "5 octobre" is a different one.
 */
export function straySchedule(line: string, allowedRaw: string): StraySchedule | null {
  const allowed = foldOutboundLine(allowedRaw).toLowerCase().replace(/\./g, '');
  const dates = new RegExp(
    `\\b(?:${EN_MONTH})\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${FR_MONTH})\\.?\\b|\\b(?:${FR_MONTH})\\.?\\s+\\d{1,2}\\b`,
    'gi',
  );
  for (const mention of line.match(dates) ?? []) {
    const token = mention.toLowerCase().replace(/\./g, '');
    if (!allowed.includes(token)) return 'stray_date';
  }
  const clocks = /\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?h(?:\s?\d{2})?\b/gi;
  for (const clock of line.match(clocks) ?? []) {
    if (!allowed.includes(clock.toLowerCase())) return 'stray_clock';
  }
  for (const day of [...EN_WEEKDAYS, ...FR_WEEKDAYS]) {
    const named = new RegExp(`\\b${day}\\b`, 'i');
    if (named.test(line) && !named.test(allowed)) return 'stray_weekday';
  }
  const money = /\$\s?\d|\b\d+\s?(?:dollars?|euros?|cad)\b/i;
  if (money.test(line) && !money.test(allowedRaw)) return 'stray_money';
  return null;
}

/** Their week, a co-parent, l'autre parent — none of which the facts contain. */
export function mentionsOtherPerson(line: string): boolean {
  return /\btheir week\b|\bco-?parents?\b|\bautre parent\b|\bleur semaine\b/i.test(line);
}

/** Hale named as someone else. The caller strips the going clause first. */
export function namesHale(line: string): boolean {
  return /\bhale\b/i.test(line);
}

export function stockOpener(line: string): boolean {
  return /^\s*just a (?:heads-up|heads up|reminder)\b/i.test(line);
}

export function stockReceiptCloser(line: string): boolean {
  return /let me know if you want it removed/i.test(line);
}

/**
 * Ordinary sentence words a receipt or an alert may capitalize. A token that
 * is not one of these, and is not a whole word of the facts, is a person the
 * facts did not name.
 */
const ORDINARY_WORDS = new Set([
  'want',
  'wants',
  'tell',
  'say',
  'said',
  'says',
  'just',
  'details',
  'something',
  'noted',
  'note',
  'please',
  'thanks',
  'thank',
  'hello',
  'hey',
  'okay',
  'here',
  'there',
  'let',
  'lets',
  'maybe',
  'also',
  'still',
  'already',
  'got',
  'heard',
  'saw',
  'noticed',
  'looks',
  'look',
  'seems',
  'seem',
  'sounds',
  'sound',
  'quick',
  'heads',
  'reminder',
  'update',
  'news',
  'added',
  'left',
  'kept',
  'moved',
  'cancelled',
  'canceled',
  'confirmed',
  'done',
  'fine',
  'well',
  'right',
  'and',
  'but',
  'for',
  'with',
  'from',
  'about',
  'into',
  'over',
  'after',
  'before',
  'because',
  'since',
  'while',
  'this',
  'that',
  'these',
  'those',
  'your',
  'youre',
  'the',
  'can',
  'could',
  'would',
  'should',
  'will',
  'not',
  'dont',
  'ive',
  'ill',
  'its',
  'cest',
  'jai',
  'dis',
  'dites',
  'ecris',
  'merci',
  'bonjour',
  'salut',
  'voici',
  'voila',
  'alors',
  'donc',
  'mais',
  'pour',
  'avec',
  'sans',
  'dans',
  'chez',
  'oui',
  'non',
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(haystack: string, word: string): boolean {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(word)}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(
    haystack,
  );
}

/** A capitalized name the facts do not contain. Null when every such word is allowed. */
export function inventedName(line: string, allowedRaw: string): string | null {
  const allowed = foldOutboundLine(allowedRaw);
  const pattern = /(?:^|[^\p{L}])([A-ZÀ-Þ][\p{L}']{2,})/gu;
  for (const match of line.matchAll(pattern)) {
    const word = match[1] ?? '';
    if (hasWord(allowed, word)) continue;
    const bare = word.toLowerCase().replace(/['’]/g, '');
    if (ORDINARY_WORDS.has(bare)) continue;
    return word;
  }
  return null;
}

/**
 * The sender, exactly, or a word-boundary prefix of it long enough to still be
 * the name (two words, eight characters). "City" alone is not the sender.
 */
export function mentionsSender(line: string, sender: string): boolean {
  const hay = foldOutboundLine(line).toLowerCase();
  const full = foldOutboundLine(sender).toLowerCase();
  if (!full) return true;
  if (hay.includes(full)) return true;
  const words = full.split(/\s+/).filter((word) => word.length > 0);
  for (let count = words.length - 1; count >= 2; count -= 1) {
    const prefix = words.slice(0, count).join(' ');
    if (prefix.length < 8) continue;
    if (hasWord(hay, prefix)) return true;
  }
  return false;
}
