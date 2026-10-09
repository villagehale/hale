'use client';

import { useEffect, useState } from 'react';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { readFirstTouchSourceCode } from '~/lib/analytics/source-code';
import { platformFromUa } from '~/lib/chooser';
import { primaryTextTarget } from '~/lib/primary-cta';

/**
 * The primary "Text Hale" door — header pill, hero, closing band, and every
 * other door that says Text Hale.
 *
 * First paint and no-JS are the /text page (carrying `?s=` when the server
 * already validated one). An `sms:` link is a dead click on Windows and Linux,
 * so the HTML never contains one. After hydration, iPhone, iPad, Mac, and
 * Android retarget the same anchor at the messaging app, prefilled, in the
 * form that OS reads (`&body=` on Apple, `?body=` on Android). The label does
 * not change, so the upgrade does not move layout. The click event follows
 * the href: `cta_message_click` while it is a navigation, `cta_text_click`
 * once it opens a composer.
 *
 * THE BODY-TOKEN SEAM (poster attribution): the `(via <code>)` token comes from
 * the remembered first-touch code (the same reader the provider uses), falling
 * back to the server-validated `source` when storage is empty. Without JS the
 * /text link still carries the server's code.
 */
export function ChooserLink({
  locale,
  placement,
  className,
  children,
  smsNumber,
  prefill,
  source = null,
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
  /** A `?s=` code the server already validated. The no-JS href carries it. */
  source?: string | null;
}) {
  const capture = useAnalytics();
  const base = localeHref(locale, '/text');
  const [target, setTarget] = useState(
    primaryTextTarget({
      platform: 'unknown',
      smsNumber,
      prefill,
      source,
      textPath: base,
    }),
  );

  useEffect(() => {
    let storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      // Safari private mode / locked-down browsers: URL-only attribution — the
      // named degrade the source-code module documents, not a swallowed bug.
      storage = null;
    }
    const code = readFirstTouchSourceCode(window.location.search, storage) ?? source;
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
  }, [base, smsNumber, prefill, source]);

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
