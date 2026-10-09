import type { ReactNode } from 'react';
import { ChooserLink } from '~/components/chooser-link';
import { LandingCta } from '~/components/landing-cta';
import type { Locale } from '~/i18n/routing';
import { chromeCta } from '~/lib/site/chrome-cta';

/**
 * A "Text Hale" control in the redesign.
 * Homepage doors navigate to /text (the chooser). Subpage doors open the
 * composer, the same way the rest of the site's bands do.
 */
export function TextDoor({
  className,
  placement,
  locale,
  smsNumber,
  prefill,
  mode,
  href,
  children,
}: {
  className?: string;
  placement: string;
  locale: Locale;
  smsNumber: string;
  prefill: string;
  mode: 'chooser' | 'sms';
  /**
   * Composer href for a door that must carry a `?s=` body token. Omitted, the
   * shared chrome CTA is used — the no-code door every other page already has.
   */
  href?: string;
  children: ReactNode;
}) {
  if (mode === 'chooser') {
    return (
      <ChooserLink
        locale={locale}
        placement={placement}
        className={className}
        smsNumber={smsNumber}
        prefill={prefill}
      >
        {children}
      </ChooserLink>
    );
  }
  const cta = chromeCta(locale);
  return (
    <LandingCta
      event="cta_text_click"
      placement={placement}
      channel="sms"
      href={href ?? cta.href}
      className={className}
    >
      {children}
    </LandingCta>
  );
}
