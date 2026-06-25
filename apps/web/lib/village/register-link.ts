/**
 * The provider owns registration; Hale owns discovery — so every activity card
 * links OUT to where a parent can read the details and sign up. We always have
 * such a link: when the discovered source URL is missing we fall back to a Google
 * search for the venue/title plus the family's COARSE area (rule #1 — never a
 * precise location), so a parent is never left without a way to register.
 */

const GOOGLE_SEARCH = 'https://www.google.com/search';

/**
 * The outbound details/registration URL for an activity. Prefers the discovered
 * source URL; when it is null/empty, builds a Google search for the title plus
 * the coarse area so the card always offers a way through to registration.
 */
export function registerLinkHref(
  sourceUrl: string | null | undefined,
  title: string,
  areaCoarse: string | null | undefined,
): string {
  const source = sourceUrl?.trim();
  if (source) return source;
  const query = [title, areaCoarse].filter(Boolean).join(' ').trim();
  return `${GOOGLE_SEARCH}?q=${encodeURIComponent(query)}`;
}
