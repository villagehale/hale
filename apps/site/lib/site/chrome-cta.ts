import { CONTACT_EMAIL, buildSmsHref, readSmsNumber } from '~/lib/text-entry';

/**
 * The one call to action the shared site chrome offers, on every page that is not
 * the homepage.
 *
 * There is no signup funnel — the only way in is texting Hale — and the header and
 * footer wrap every subpage, so this is the product's front door on eleven surfaces.
 * One helper rather than a literal per surface so the header and the footer can never
 * disagree about what that door is.
 *
 * With no number provisioned it degrades to email, matching the homepage: a dead
 * `sms:` link is worse than an honest address.
 */
export interface ChromeCta {
  label: string;
  href: string;
}

/**
 * Where the chrome's "Features" link points. The homepage has no #features section
 * to jump to, so an anchor href would scroll a reader nowhere from all eleven
 * subpages.
 */
export function featuresHref(): string {
  return '/';
}

export function chromeCta(): ChromeCta {
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  return number
    ? { label: 'Text Hale', href: buildSmsHref(number, null) }
    : { label: 'Email Hale', href: `mailto:${CONTACT_EMAIL}` };
}
