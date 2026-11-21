/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting: an untrusted field at a wired call site enters the prompt wrapped the
 * same way, so the model can tell data from instructions. Not every prompt is wired
 * yet (VIL-560). Callers pass `enabled` from `isEnabled('untrusted-field-marking')`.
 * Off, the value is returned unchanged, so a dark flag does not re-key a cached prompt.
 */

export type UntrustedSource = 'email' | 'calendar' | 'web' | 'other';

export const UNTRUSTED_CLOSE = '</untrusted>';

/**
 * A payload key is attacker-controlled when the tree walker uses it as `field`.
 * Quotes, brackets and newlines in that key must not end the attribute or the tag.
 */
function escapeField(field: string): string {
  return field
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

export function untrustedOpen(source: UntrustedSource, field: string): string {
  return `<untrusted source="${source}" field="${escapeField(field)}">`;
}

/**
 * Any closing tag a model could read as ours: any case, spaces, invisible characters,
 * accents, full-width forms, an escaped slash, attributes, or no closing bracket at
 * all. The email-alert fence (`</untrusted_email_body>`) shares the name, so it is
 * covered here too.
 */
const CLOSING_TAG = /[<\uff1c\ufe64]([\s\p{Cf}\p{M}\\]*[/\uff0f][^<>\uff1c\uff1e\ufe64\ufe65]*)/gu;
const CLOSER_NAME = 'untrusted';

/**
 * Hostile text must not be able to close the mark. A closer loses its opening bracket,
 * so it stays readable and is no longer a tag in any spelling.
 */
export function neutralizeUntrustedClosers(value: string): string {
  return value.replace(CLOSING_TAG, (tag, afterBracket: string) => {
    const name = afterBracket
      .normalize('NFKD')
      .replace(/[\s\p{Cf}\p{M}\\/]/gu, '')
      .toLowerCase();
    return name.startsWith(CLOSER_NAME) ? `&lt;${afterBracket}` : tag;
  });
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

export function markUntrusted(source: UntrustedSource, field: string, value: string): string {
  return `${untrustedOpen(source, field)}\n${neutralizeUntrustedClosers(value)}\n${UNTRUSTED_CLOSE}`;
}

/** Wrap every string in a JSON-able value, keeping the shape. Numbers and nulls stay. */
export function markUntrustedTree(source: UntrustedSource, value: unknown): unknown {
  return markTree(source, value, 'value');
}

function markTree(source: UntrustedSource, value: unknown, field: string): unknown {
  if (typeof value === 'string') return markUntrusted(source, field, value);
  if (Array.isArray(value)) return value.map((item) => markTree(source, item, field));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        markTree(source, item, key),
      ]),
    );
  }
  return value;
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

export function presentUntrustedTree(
  enabled: boolean,
  source: UntrustedSource,
  value: unknown,
): unknown {
  return enabled ? markUntrustedTree(source, value) : value;
}
