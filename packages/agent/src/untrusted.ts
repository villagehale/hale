/**
 * VIL-560 · one mark for untrusted email, calendar and web content in a prompt.
 *
 * Spotlighting (AgentDojo / the Rule of Two): every untrusted field enters a
 * model call wrapped the same way, so the model can tell data from instructions.
 * Off unless UNTRUSTED_FIELD_MARKING_ENABLED is exactly `true`. Unset, a
 * trailing newline, `TRUE`, `on`, and `1` stay off, and every helper is identity
 * — request bytes (and therefore eval cache keys) do not change.
 */

export const UNTRUSTED_FIELD_MARKING_ENABLED_ENV = 'UNTRUSTED_FIELD_MARKING_ENABLED';

export type UntrustedSource = 'email' | 'calendar' | 'web';

export const UNTRUSTED_CLOSE = '</untrusted>';

export function untrustedFieldMarkingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[UNTRUSTED_FIELD_MARKING_ENABLED_ENV] === 'true';
}

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
    case 'family_event_invite':
    case 'calendar_conflict_detected':
      return 'calendar';
    case 'web':
    case 'page':
    case 'pdf':
      return 'web';
    default:
      return 'email';
  }
}

/** Wrap one untrusted string. Off: the same string, unchanged. */
export function markUntrusted(
  source: UntrustedSource,
  field: string,
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!untrustedFieldMarkingEnabled(env)) return value;
  return `${untrustedOpen(source, field)}\n${escapeUntrusted(value)}\n${UNTRUSTED_CLOSE}`;
}

/**
 * Wrap every string in a JSON-able value, keeping the shape. Off: the same
 * reference, so a caller that compared by identity still matches.
 */
export function markUntrustedTree(
  source: UntrustedSource,
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (!untrustedFieldMarkingEnabled(env)) return value;
  return markTree(source, value, 'value', env);
}

function markTree(
  source: UntrustedSource,
  value: unknown,
  field: string,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === 'string') return markUntrusted(source, field, value, env);
  if (Array.isArray(value)) return value.map((item) => markTree(source, item, field, env));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        markTree(source, item, key, env),
      ]),
    );
  }
  return value;
}
