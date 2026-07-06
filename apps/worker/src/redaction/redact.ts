/**
 * PII redaction for the shadow eval (rule #1). Strips family PII from an input
 * before a prompt sees it, and assertNoPII fails CLOSED — if any PII pattern
 * survives, it throws, so the caller drops the input rather than leak it.
 *
 * Deliberately over-redacts: a false positive (a redacted non-PII token) is
 * harmless for a shadow comparison; a false negative (leaked PII) violates rule
 * #1. When in doubt, redact.
 */

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// Canadian postal: A1A 1A1 / A1A1A1.
const POSTAL_RE = /\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/g;
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

/** Redact known child names + dates/postal/email/phone from free text. */
export function redactText(text: string, knownChildNames: readonly string[] = []): string {
  let out = text;
  const nre = nameRe(knownChildNames);
  if (nre) out = out.replace(nre, '[CHILD]');
  // Email before phone (an email can contain digit runs a phone regex would grab).
  out = out.replace(EMAIL_RE, '[EMAIL]');
  out = out.replace(POSTAL_RE, '[POSTAL]');
  out = out.replace(DATE_RE, '[DATE]');
  out = out.replace(PHONE_RE, '[PHONE]');
  return out;
}

/** Deep-redact every string value in a payload; non-strings pass through. */
export function redactEventPayload<T>(payload: T, knownChildNames: readonly string[] = []): T {
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
  if (POSTAL_RE.test(text)) hits.push('postal');
  if (DATE_RE.test(text)) hits.push('date');
  if (PHONE_RE.test(text)) hits.push('phone');
  // RegExp with /g is stateful (lastIndex) — reset so a reused instance is clean.
  for (const re of [EMAIL_RE, POSTAL_RE, DATE_RE, PHONE_RE]) re.lastIndex = 0;
  if (hits.length) {
    throw new Error(`PII leak — redaction left ${hits.join(', ')} in the input; dropping (rule #1)`);
  }
}
