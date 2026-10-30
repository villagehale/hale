/**
 * The single shared Langfuse mask (hard rule #1 — "sensitive data masked").
 *
 * Langfuse calls this on the stringified `data` of every observation's input,
 * output, and metadata BEFORE the span leaves the process — even on the HIPAA
 * instance. It is the defence-in-depth backstop behind the structural redaction
 * the agent paths already apply (coach/context.ts surfaces teens as stage-only;
 * the pipeline carries a `teenContent` flag): if a teen's raw content or a piece
 * of contact PII ever reaches a trace payload, it never reaches Langfuse.
 *
 * What is REDACTED (never sent to Langfuse):
 *   - A 13+ child's RAW content. Detected by a teen marker in the payload
 *     (`teen_content` / `teenContent` === true). When present, the free-text
 *     content fields (raw_content / rawContent / body / subject / content / text /
 *     answer / message) are replaced with a category placeholder; the event
 *     category and a length hint are kept so the trace stays diagnosable.
 *   - Emails, phone numbers, Canadian postal codes, and precise street addresses,
 *     scrubbed by pattern from the WHOLE string unconditionally (so they're gone
 *     even when they appear in a non-teen payload's free text).
 *
 * What MAY be sent (HIPAA-grade, intentionally NOT masked):
 *   - Non-teen content (newborn/toddler/child) — the product's core signal.
 *   - A child's first name and DOB — needed to ground per-child reasoning.
 *
 * The function is pure, synchronous, deterministic, and total: any input shape
 * (string, non-JSON, object-as-string) returns a string; it never throws (a mask
 * that throws would drop the whole export batch — see the Langfuse masking docs).
 */

const TEEN_CONTENT_PLACEHOLDER = '[REDACTED_TEEN_CONTENT]';
const EMAIL_PLACEHOLDER = '[REDACTED_EMAIL]';
const PHONE_PLACEHOLDER = '[REDACTED_PHONE]';
const POSTAL_PLACEHOLDER = '[REDACTED_POSTAL]';
const ADDRESS_PLACEHOLDER = '[REDACTED_ADDRESS]';

/** Free-text fields that carry a child's raw content; redacted when the payload
 * is teen-flagged. Names cover both the snake_case wire shape (pipeline signals)
 * and the camelCase domain shape. */
const RAW_CONTENT_FIELDS = new Set([
  'raw_content',
  'rawContent',
  'body',
  'subject',
  'content',
  'text',
  'answer',
  'message',
  'question',
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** North-American phone numbers: separated (optional +1, separators ., -, space,
 * or ()) OR a bare 10/11-digit run. Rule #1 defaults to most restrictive, so a
 * bare 10-digit number is redacted even though it could in theory be another id. */
const PHONE_RE =
  /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b|\b1?\d{10}\b/g;
/** Canadian postal code A1A 1A1 (optional space). */
const POSTAL_RE = /\b[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d\b/g;
/** A precise street address: number + street name + street-type suffix. */
const ADDRESS_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,3}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Crescent|Cres|Terrace|Terr)\b\.?/gi;

function scrubPii(text: string): string {
  return text
    .replace(EMAIL_RE, EMAIL_PLACEHOLDER)
    .replace(ADDRESS_RE, ADDRESS_PLACEHOLDER)
    .replace(POSTAL_RE, POSTAL_PLACEHOLDER)
    .replace(PHONE_RE, PHONE_PLACEHOLDER);
}

/** True when a parsed payload (or any nested object) is flagged as teen content. */
function carriesTeenMarker(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(carriesTeenMarker);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.teen_content === true || obj.teenContent === true) {
      return true;
    }
    return Object.values(obj).some(carriesTeenMarker);
  }
  return false;
}

/** Replace raw-content fields with a placeholder + length hint, recursively. */
function redactTeenContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactTeenContent);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (RAW_CONTENT_FIELDS.has(key) && typeof child === 'string') {
        out[key] = `${TEEN_CONTENT_PLACEHOLDER}(${child.length})`;
      } else {
        out[key] = redactTeenContent(child);
      }
    }
    return out;
  }
  return value;
}

/**
 * The mask Langfuse invokes per observation attribute. `data` is the stringified
 * JSON of the attribute value (Langfuse stringifies before calling — see docs).
 * Returns a string; never throws.
 */
export function haleMask({ data }: { data: unknown }): string {
  const asString = typeof data === 'string' ? data : safeStringify(data);

  let parsed: unknown;
  try {
    parsed = JSON.parse(asString);
  } catch {
    // Not JSON (plain prose, e.g. an answer string) — scrub PII patterns only.
    return scrubPii(asString);
  }

  const teenRedacted = carriesTeenMarker(parsed) ? redactTeenContent(parsed) : parsed;
  return scrubPii(JSON.stringify(teenRedacted));
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
