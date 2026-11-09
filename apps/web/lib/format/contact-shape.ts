import { inShape, redactInShape } from '../channel/place-token';
import { asHandsetReads, hasLinkShape, linksOutside, wordsAsHandsetReads } from './link-shape';

/**
 * VIL-633 · The one check for "this text tells the parent how to reach someone": a link, a
 * phone number or an email address. A model-written line never carries one it was not
 * handed (code adds links on their own line), and a third party's words (a calendar title)
 * lose theirs before a writer sees them. Links are read by link-shape.ts; this file adds
 * phones and emails on the same readings, and writes no link pattern of its own.
 *
 * Relative imports only, so the eval runners can load it as-is.
 */

/**
 * Seven or more digits, each at most three separators (space, dot, hyphen, parenthesis)
 * from the next, read on the place-token shape: a digit of any script is the digit, any
 * dash a hyphen, and a zero-width character is not there. A short service number (911,
 * 988, 811) is three digits, so it is not a phone. A colon or a slash is not a separator,
 * so a clock range ("10:00-10:45") or a date ("11/08") is not one either. It fails closed:
 * a dotted time range of seven digits reads as a phone, which costs the writer a re-draft.
 */
const PHONE = /\+?\(?\d(?:[\s.()-]{0,3}\d){6,}/g;
/** A word with a letter or digit on each side of an `@` (NFKC reads '＠' as '@'). */
const EMAIL = /[\p{L}\p{N}._%+-]@[\p{L}\p{N}]/u;

export type ContactKind = 'link' | 'phone' | 'email';

function phoneDigits(text: string): string[] {
  return Array.from(inShape(text).matchAll(PHONE), (match) => match[0].replace(/\D/g, ''));
}

function emailWords(text: string): string[] {
  return wordsAsHandsetReads(text)
    .filter((word) => EMAIL.test(word))
    .map((word) => word.toLowerCase());
}

/**
 * The kinds of contact in `text` that none of `handed` carries. A phone counts as handed
 * only as the same whole run of digits, and a link or an email only as the same whole
 * word, so a number or host built around a handed one is another contact.
 */
export function contactsOutside(text: string, handed: readonly string[]): ContactKind[] {
  const found: ContactKind[] = [];
  if (linksOutside(text, handed).length > 0) found.push('link');
  const handedPhones = new Set(handed.flatMap(phoneDigits));
  if (phoneDigits(text).some((digits) => !handedPhones.has(digits))) found.push('phone');
  const handedEmails = new Set(handed.flatMap(emailWords));
  if (emailWords(text).some((word) => !handedEmails.has(word))) found.push('email');
  return found;
}

/**
 * `text` less every phone run and every link- or email-shaped word, in the words as typed.
 * What is left is read again, and when the words that remain still close into a contact
 * ("evil . app" once a word between them is gone) nothing is kept.
 */
export function withoutContacts(text: string): string {
  const kept = redactInShape(text, PHONE, ' ')
    .split(/\s+/)
    .filter((word) => word !== '' && !hasLinkShape(word) && !EMAIL.test(asHandsetReads(word)))
    .join(' ');
  return contactsOutside(kept, []).length === 0 ? kept : '';
}
