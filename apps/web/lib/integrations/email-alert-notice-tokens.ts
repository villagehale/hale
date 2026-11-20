import { asHandsetReads, linksOutside } from '~/lib/format/link-shape';

/**
 * VIL-628 at email-alert compose: when the writer saw the email body, drop phones,
 * codes and hosts the trusted facts do not carry. The email is never parsed for what
 * to drop — anything in the draft that the facts do not vouch for is cut. A draft
 * that did not see a body is left to the existing refusals (empty, a link).
 *
 * Hosts use the shared link check. Phones are 7 or more digits. Codes are letter-digit
 * tokens of 5 or more characters. Names are not checked (VIL-628).
 */

const PHONE = /\+?\d[\d\s.\-()]{6,}\d/g;
const PHONE_MIN_DIGITS = 7;
const CODE = /(?<![A-Za-z0-9_-])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?![A-Za-z0-9_])/g;
const CODE_MIN_CHARS = 5;
const WORD_EDGE = /^[([{<"“‘]+|[.,;:!?)\]}>"”’]+$/gu;

function digitsOf(text: string): string {
  return text.replace(/\D/g, '');
}

function isCode(token: string): boolean {
  return (
    /\d/.test(token) &&
    /[A-Za-z]/.test(token) &&
    token.replace(/[-_]/g, '').length >= CODE_MIN_CHARS
  );
}

function codeKey(token: string): string {
  return token.replace(/[-_]/g, '').toLowerCase();
}

function trustedPhones(trusted: string): Set<string> {
  const found = new Set<string>();
  for (const match of asHandsetReads(trusted).matchAll(PHONE)) {
    const digits = digitsOf(match[0]);
    if (digits.length >= PHONE_MIN_DIGITS) found.add(digits);
  }
  return found;
}

function trustedCodes(trusted: string): Set<string> {
  const found = new Set<string>();
  for (const match of asHandsetReads(trusted).matchAll(CODE)) {
    if (isCode(match[0])) found.add(codeKey(match[0]));
  }
  return found;
}

function phoneTrusted(digits: string, trusted: ReadonlySet<string>): boolean {
  if (trusted.has(digits)) return true;
  for (const known of trusted) {
    if (known.endsWith(digits) || digits.endsWith(known)) return true;
  }
  return false;
}

function dropHosts(text: string, trusted: string): string {
  const untrusted = new Set(linksOutside(text, [trusted]));
  if (untrusted.size === 0) return asHandsetReads(text);
  return asHandsetReads(text)
    .split(/\s+/)
    .filter((word) => {
      if (word.length === 0) return false;
      const lower = word.toLowerCase();
      const bare = word.replace(WORD_EDGE, '').toLowerCase();
      return !untrusted.has(lower) && !untrusted.has(bare);
    })
    .join(' ');
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .trim();
}

/** Cut phones, codes and hosts in `text` that `trusted` (the facts JSON) does not carry. */
export function stripEmailOnlyNoticeTokens(text: string, trusted: string): string {
  const phones = trustedPhones(trusted);
  const codes = trustedCodes(trusted);
  let next = dropHosts(text, trusted);
  next = next.replace(PHONE, (match) => {
    const digits = digitsOf(match);
    if (digits.length >= PHONE_MIN_DIGITS && !phoneTrusted(digits, phones)) return ' ';
    return match;
  });
  next = next.replace(CODE, (match) => {
    if (isCode(match) && !codes.has(codeKey(match))) return ' ';
    return match;
  });
  return tidy(next);
}
