import type { ReactNode } from 'react';
import { ChooserLink } from '~/components/chooser-link';
import { LandingCta } from '~/components/landing-cta';
import type { Locale } from '~/i18n/routing';
import { chromeCta } from '~/lib/site/chrome-cta';

/**
 * A "Text Hale" control in the redesign.
 *
 * With a live number, the server-rendered href is /text (carrying `?s=` when
 * the page validated one). The client upgrades that same anchor to `sms:` on
 * iPhone, iPad, Mac, and Android. With no number, the door is the chrome
 * email fallback — a /text page with nothing to text is not a door.
 */
export function TextDoor({
  className,
  placement,
  locale,
  smsNumber,
  prefill,
  mode: _mode,
  source = null,
  children,
}: {
  className?: string;
  placement: string;
  locale: Locale;
  smsNumber: string;
  prefill: string;
  /** Kept so existing call sites stay source-compatible. Both modes share the door. */
  mode: 'chooser' | 'sms';
  /** A `?s=` code the page already validated. */
  source?: string | null;
  children: ReactNode;
}) {
  if (smsNumber === '') {
    const cta = chromeCta(locale);
    return (
      <LandingCta
        event="cta_text_click"
        placement={placement}
        href={cta.href}
        className={className}
      >
        {children}
      </LandingCta>
    );
  }
  return (
    <ChooserLink
      locale={locale}
      placement={placement}
      className={className}
      smsNumber={smsNumber}
      prefill={prefill}
      source={source}
    >
      {children}
    </ChooserLink>
  );
}
