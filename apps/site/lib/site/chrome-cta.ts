import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { CONTACT_EMAIL, buildSmsHref, readSmsNumber } from '~/lib/text-entry';

/**
 * The one call to action the shared site chrome offers, on every page that is not
 * the homepage.
 *
 * There is no signup funnel — the only way in is texting Hale — and the header and
 * footer wrap every page, so this is the product's front door across the site. One
 * helper rather than a literal per surface so the header and the footer can never
 * disagree about what that door is, and the label speaks the reader's language.
 *
 * With no number provisioned it degrades to email: a dead `sms:` link is worse
 * than an honest address.
 */
export interface ChromeCta {
  label: string;
  href: string;
}

export function chromeCta(locale: Locale = routing.defaultLocale): ChromeCta {
  const t = getTranslator(locale, 'Common');
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  return number
    ? { label: t('textHale'), href: buildSmsHref(number, null) }
    : { label: t('emailHale'), href: `mailto:${CONTACT_EMAIL}` };
}
