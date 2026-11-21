import { createHash } from 'node:crypto';

/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting: an untrusted field at a wired call site enters the prompt wrapped the
 * same way, so the model can tell data from instructions. Not every prompt is wired
 * yet (VIL-560). Callers pass `enabled` from `isEnabled('untrusted-field-marking')`.
 * Off, the value is returned unchanged, so a dark flag does not re-key a cached prompt.
 */

export type UntrustedSource = 'email' | 'calendar' | 'web' | 'other';

const TAG_ID_HEX_LENGTH = 24;

/**
 * A tag name carrying a hash of the value it wraps. The value cannot spell its own
 * closer in any encoding, because writing the id into the value changes the id. The
 * hash is deterministic, so a cached prompt keeps its key.
 */
export function untrustedTag(name: string, value: string): string {
  const id = createHash('sha256').update(value).digest('hex').slice(0, TAG_ID_HEX_LENGTH);
  return `${name}-${id}`;
}

/** Quotes, brackets and newlines in a field name must not end the attribute or the tag. */
function escapeField(field: string): string {
  return field
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

/** Maps where a row came from (`events.source`), so a label never comes from content. */
export function untrustedSourceFor(origin: string): UntrustedSource {
  switch (origin) {
    case 'gmail':
    case 'email':
      return 'email';
    case 'gcal':
    case 'calendar':
      return 'calendar';
    case 'web':
    case 'page':
    case 'pdf':
      return 'web';
    default:
      return 'other';
  }
}

/**
 * A space, not a newline, around the value. In a JSON-encoded prompt a newline becomes a
 * literal `\n`, and its `n` removes the word boundary the telemetry scrubbers need to
 * catch an address or phone number at the start of the value.
 */
export function markUntrusted(source: UntrustedSource, field: string, value: string): string {
  const tag = untrustedTag('untrusted', value);
  return `<${tag} source="${source}" field="${escapeField(field)}"> ${value} </${tag}>`;
}

/** The bytes a prompt should carry: marked when the flag is on, unchanged when it is off. */
export function presentUntrusted(
  enabled: boolean,
  source: UntrustedSource,
  field: string,
  value: string,
): string {
  return enabled ? markUntrusted(source, field, value) : value;
}

/** One mark around a JSON-able value, so its keys sit inside the mark with its strings. */
export function presentUntrustedJson(
  enabled: boolean,
  source: UntrustedSource,
  field: string,
  value: unknown,
): unknown {
  return enabled ? markUntrusted(source, field, JSON.stringify(value)) : value;
}
