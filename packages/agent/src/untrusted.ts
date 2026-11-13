/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting (AgentDojo / the Rule of Two): every untrusted field enters a
 * model call wrapped the same way, so the model can tell data from instructions.
 */

export type UntrustedSource = 'email' | 'calendar' | 'web';

export const UNTRUSTED_CLOSE = '</untrusted>';

export function untrustedOpen(source: UntrustedSource, field: string): string {
  return `<untrusted source="${source}" field="${field}">`;
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

/** Wrap every string in a JSON-able value, keeping the shape. */
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
