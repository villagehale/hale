// The product app's base URL — sign-in, onboarding, Privacy, Terms all live
// there, not on the marketing site. One source for every cross-link out; the
// header/footer and the landing CTAs all read it. Overridable per env.
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.villagehale.com';
