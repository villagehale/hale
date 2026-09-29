const DROPPED_KEY = /name|email|phone|postal|address|dob|body|utterance|value|first|last/i;
const EMAILISH = /@/;
const PHONEISH = /\+\d{8,}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;

/**
 * Audit payloads for signup may carry ids, reason codes, field names, and a
 * host. They may not carry a person.
 */
export function redactSignupAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSignupAudit(item));
  if (!value || typeof value !== 'object') return scrubString(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_KEY.test(key)) continue;
    out[key] = redactSignupAudit(item);
  }
  return out;
}

function scrubString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (EMAILISH.test(value) || PHONEISH.test(value)) return '[redacted]';
  return value;
}
