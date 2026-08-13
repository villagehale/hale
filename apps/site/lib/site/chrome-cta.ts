import { APP_URL } from '~/lib/app-url';
import { f14LandingEnabled } from '~/lib/flags/landing';
import { CONTACT_EMAIL, buildSmsHref, readSmsNumber } from '~/lib/text-entry';

/**
 * The one call to action the shared site chrome offers, on every page that is not
 * the homepage.
 *
 * The F14 landing deliberately closed the signup funnel — the only way in is texting
 * Hale — but the header and footer wrapped around every subpage kept pointing at
 * /onboarding, so a parent who read the FAQ was handed back the exact door the
 * homepage had shut. One helper rather than two branches so the header and the
 * footer can never disagree about what the product's front door is.
 *
 * With no number provisioned the F14 branch degrades to email, matching the
 * homepage: a dead `sms:` link is worse than an honest address.
 */
export interface ChromeCta {
  label: string;
  href: string;
}

/**
 * Where the chrome's "Features" link points. The village homepage has a #features
 * section to jump to; the chief-of-staff landing has no such anchor, so under F14
 * the same href would scroll a reader nowhere from all eleven subpages.
 */
export function featuresHref(): string {
  return f14LandingEnabled() ? '/' : '/#features';
}

export function chromeCta(): ChromeCta {
  if (!f14LandingEnabled()) {
    return { label: 'Get started', href: `${APP_URL}/onboarding` };
  }
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  return number
    ? { label: 'Text Hale', href: buildSmsHref(number, null) }
    : { label: 'Email Hale', href: `mailto:${CONTACT_EMAIL}` };
}
