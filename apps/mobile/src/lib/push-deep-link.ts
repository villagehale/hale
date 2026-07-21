/**
 * Push notification tap → app route. A notification's `data.deepLink` is a compact,
 * provider-agnostic token (the same field VIL-213/A2 stamps on the message) that this
 * resolves to exactly one whitelisted surface. Kept framework-free (no expo-router
 * import) so it is unit-tested off-device; the tap listener casts the returned path to
 * an Href. Whitelisting is the point (rule #1-adjacent): a push must never be able to
 * navigate the app to an arbitrary path — an unknown token or a malformed/traversal id
 * resolves to null and the tap is ignored.
 *
 * Tokens: `plan` → /plan · `approval:<id>` → /approval/<id> · `thread:<id>` → /thread/<id>.
 */

/** Ids are opaque uuid-ish strings; bound the shape so a token can't smuggle a path
 * segment (`../`, a slash) into the route. */
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export function routeForDeepLink(deepLink: string): string | null {
  const token = deepLink.trim();
  if (token === 'plan') return '/plan';

  const colon = token.indexOf(':');
  if (colon < 0) return null;
  const prefix = token.slice(0, colon);
  const id = token.slice(colon + 1);
  if (!ID_RE.test(id)) return null;

  if (prefix === 'approval') return `/approval/${id}`;
  if (prefix === 'thread') return `/thread/${id}`;
  return null;
}

/** Read `data.deepLink` off a notification's opaque data payload and resolve it. */
export function notificationRouteFor(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const deepLink = (data as { deepLink?: unknown }).deepLink;
  if (typeof deepLink !== 'string') return null;
  return routeForDeepLink(deepLink);
}
