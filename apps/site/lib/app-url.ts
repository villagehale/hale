// The product app's base URL — sign-in, onboarding, Privacy, Terms all live
// there, not on the marketing site. One source for every cross-link out; the
// header/footer and the landing CTAs all read it. Overridable per env.
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';

// The marketing site's own canonical origin — used for metadataBase, canonical
// links, sitemap, and robots. MUST be the served URL: the apex (villagehale.com)
// 308-redirects to www, so www is canonical — pointing canonical at the apex
// would target a redirecting URL. Overridable per env.
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.villagehale.com';
