'use client';

import { useEffect, useState } from 'react';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { readFirstTouchSourceCode } from '~/lib/analytics/source-code';
import { platformFromUa } from '~/lib/chooser';
import { primaryTextTarget } from '~/lib/primary-cta';

/**
 * The primary "Text Hale" door — header pill, hero, closing band.
 *
 * First paint (and no JS, and every desktop) is the /text page: the QR and the
 * number already live there, and an `sms:` link is a dead click on Windows and
 * Linux. After hydration a phone retargets the same anchor at the messaging
 * app, prefilled, in the form that OS reads (`&body=` on iOS, `?body=` on
 * Android). The click event follows the href: `cta_message_click` while it is
 * a navigation, `cta_text_click` once it opens a composer.
 *
 * THE BODY-TOKEN SEAM (poster attribution): the `(via <code>)` token comes from
 * the remembered first-touch code (the same reader the provider uses). Without
 * JS the /text page still opens; only the body token is dropped.
 */
export function ChooserLink({
  locale,
  placement,
  className,
  children,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  placement: string;
  className?: string;
  children: React.ReactNode;
  /** Already-validated E.164, or '' when the number is not live. */
  smsNumber: string;
  /** Locked composer body for this locale. The server passes it; this client
   * component does not load the message bundles. */
  prefill: string;
}) {
  const capture = useAnalytics();
  const base = localeHref(locale, '/text');
  const [target, setTarget] = useState({ href: base, composer: false });

  useEffect(() => {
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      // Safari private mode / locked-down browsers: URL-only attribution — the
      // named degrade the source-code module documents, not a swallowed bug.
      storage = null;
    }
    const code = readFirstTouchSourceCode(window.location.search, storage);
    const ua = typeof navigator === 'undefined' ? null : (navigator.userAgent ?? null);
    setTarget(
      primaryTextTarget({
        platform: platformFromUa(ua),
        smsNumber,
        prefill,
        source: code,
        textPath: base,
      }),
    );
  }, [base, smsNumber, prefill]);

  return (
    <a
      href={target.href}
      className={className}
      data-cta={target.composer ? 'cta_text_click' : 'cta_message_click'}
      data-cta-placement={placement}
      {...(target.composer ? { 'data-cta-channel': 'sms' as const } : {})}
      onClick={() =>
        capture(
          target.composer ? 'cta_text_click' : 'cta_message_click',
          target.composer
            ? { cta_placement: placement, channel: 'sms' }
            : { cta_placement: placement },
        )
      }
    >
      {children}
    </a>
  );
}
