/**
 * The outbound details/registration URL for an activity, mirrored from the web
 * (`apps/web/lib/village/register-link.ts`). The provider owns registration; Hale
 * owns discovery — so every card links OUT to where a parent can read the details
 * and sign up. We ALWAYS have such a link: when the discovered source URL is
 * missing we fall back to a Google search for the title (rule #1: never a precise
 * location), so the Register/Source affordance always resolves like web.
 */

const GOOGLE_SEARCH = 'https://www.google.com/search';

export function registerLinkHref(sourceUrl: string | null | undefined, title: string): string {
  const source = sourceUrl?.trim();
  if (source) return source;
  return `${GOOGLE_SEARCH}?q=${encodeURIComponent(title.trim())}`;
}
