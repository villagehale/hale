/**
 * PII redaction (rule #1) for the classifier's input (web pipeline/classify.ts, worker
 * agents/classifier.ts), the Google sync payload it enqueues (web integrations/sync.ts),
 * and the shadow eval. Strips family PII from an input
 * before a prompt sees it, and assertNoPII fails CLOSED — if any PII pattern
 * survives, it throws, so the caller drops the input rather than leak it.
 *
 * Over-redacts free text: a false positive (a redacted non-PII token) costs a
 * word; a false negative (leaked PII) violates rule #1. When in doubt, redact.
 */

import { placeTokensIn, scrubPlaceTokens } from '@hale/types';

/**
 * An address. A match starts at the first character of a run of address characters, or at
 * a + straight after an address, because a domain cannot hold a + and the last match
 * stopped there. Any other start in the run would rescan it (quadratic) and find nothing
 * the first start did not.
 */
export const EMAIL_RE = /(?:(?<![\w.+-])|(?=\+)(?<=@[\w.-]+))[\w.+-]+@[\w-]+\.[\w.-]+/g;
// ISO-ish date: YYYY-MM-DD.
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
// NANP phone: optional +1, 3-3-4 with common separators.
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nameRe(names: readonly string[]): RegExp | null {
  const parts = names.filter((n) => n?.trim()).map(escapeRe);
  return parts.length ? new RegExp(`\\b(?:${parts.join('|')})\\b`, 'gi') : null;
}

/** Redact known child names + dates/postal/ZIP/email/phone from free text. */
export function redactText(text: string, knownChildNames: readonly string[]): string {
  let out = text;
  const nre = nameRe(knownChildNames);
  if (nre) out = out.replace(nre, '[CHILD]');
  // Email before phone (an email can contain digit runs a phone regex would grab).
  out = out.replace(EMAIL_RE, '[EMAIL]');
  out = out.replace(DATE_RE, '[DATE]');
  out = out.replace(PHONE_RE, '[PHONE]');
  // A postal code or a ZIP by the matcher every search shares, last, so a phone's or a
  // date's digits are already gone.
  return scrubPlaceTokens(out, '[POSTAL]');
}

/** Deep-redact every string value in a payload, under every key; non-strings pass through.
 * A caller that must keep a provider's own id sets it aside itself (integrations/sync.ts). */
export function redactEventPayload<T>(payload: T, knownChildNames: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v, knownChildNames);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, walk(val)]));
    }
    return v;
  };
  return walk(payload) as T;
}

/**
 * Fail-closed gate: throws if ANY PII pattern (known name / date / postal / email
 * / phone) survives in `text`. The shadow eval calls this after redaction and
 * DROPS the input on throw, so raw PII can never reach a prompt.
 */
export function assertNoPII(text: string, knownChildNames: readonly string[] = []): void {
  const nre = nameRe(knownChildNames);
  const hits: string[] = [];
  if (nre?.test(text)) hits.push('name');
  if (EMAIL_RE.test(text)) hits.push('email');
  if (placeTokensIn(text).length > 0) hits.push('postal');
  if (DATE_RE.test(text)) hits.push('date');
  if (PHONE_RE.test(text)) hits.push('phone');
  // RegExp with /g is stateful (lastIndex) — reset so a reused instance is clean.
  for (const re of [EMAIL_RE, DATE_RE, PHONE_RE]) re.lastIndex = 0;
  if (hits.length) {
    throw new Error(
      `PII leak — redaction left ${hits.join(', ')} in the input; dropping (rule #1)`,
    );
  }
}
