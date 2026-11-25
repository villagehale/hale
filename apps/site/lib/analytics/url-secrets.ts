import type { CaptureResult } from 'posthog-js';

/**
 * Query and hash values that act as a key: the Stripe Checkout Session id on the success
 * page, and the app's texted-link tokens a referrer can carry. Same list as apps/web's
 * PostHog provider. A page whose URL holds one does not load PostHog at all (a first load
 * sends the URL in the flags request, past `before_send`); a later event that still names
 * one goes out with a placeholder.
 */
const SECRET_PARAMS = ['session_id', 't', 'token', 'sig', 'u', 'code', 'state', 'email'];
const SECRET_QUERY = new RegExp(
  `([?&#]|%3F|%26|%23)(${SECRET_PARAMS.join('|')})(=|%3D)[^&#"'\\\\\\s]*`,
  'gi',
);

/** True when a query string or hash (with or without its leading `?` or `#`) holds a secret. */
export function hasSecretQuery(search: string): boolean {
  const params = new URLSearchParams(search.replace(/^[?#]/, ''));
  return SECRET_PARAMS.some((name) => params.has(name));
}

function redact<T>(value: T): T {
  if (typeof value === 'string') return value.replace(SECRET_QUERY, '$1$2$3[redacted]') as T;
  if (Array.isArray(value)) return value.map(redact) as T;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [redact(key), redact(inner)]),
    ) as T;
  }
  return value;
}

export function redactSecretEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  return {
    ...event,
    properties: redact(event.properties),
    ...(event.$set ? { $set: redact(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: redact(event.$set_once) } : {}),
  };
}
