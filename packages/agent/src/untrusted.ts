/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting: every untrusted field enters a model call wrapped the same way,
 * so the model can tell data from instructions. Callers pass `enabled` from
 * `isEnabled('untrusted-field-marking')`. Off, the value is returned unchanged,
 * so a dark flag does not re-key a cached prompt.
 */

export type UntrustedSource = 'email' | 'calendar' | 'web';

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
 * Hostile text must not be able to close the mark. A closer in the value is
 * broken up so it is still readable and is no longer the delimiter.
 */
function escapeUntrusted(value: string): string {
  return value.replaceAll(UNTRUSTED_CLOSE, '< /untrusted>');
}

export function untrustedSourceFor(origin: string): UntrustedSource {
  switch (origin) {
    case 'gcal':
    case 'calendar':
    case 'family_event_invite':
      return 'calendar';
    case 'web':
    case 'page':
    case 'pdf':
      return 'web';
    default:
      return 'email';
  }
}

export function markUntrusted(source: UntrustedSource, field: string, value: string): string {
  return `${untrustedOpen(source, field)}\n${escapeUntrusted(value)}\n${UNTRUSTED_CLOSE}`;
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
