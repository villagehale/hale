'use client';

import { useEffect, useState } from 'react';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { SOURCE_CODE_PARAM, readFirstTouchSourceCode } from '~/lib/analytics/source-code';

/**
 * An internal CTA to the /text chooser — the header pill, the hero and the
 * closing band all open the channel choice rather than one composer, so the
 * button works on every device.
 *
 * THE BODY-TOKEN SEAM (poster attribution): analytics attribution survives the
 * hop through the provider's first-touch `source_code`, but the chooser is
 * server-rendered and cannot read sessionStorage — the `(via <code>)` token in
 * the pre-filled SMS/WhatsApp body comes from ITS url's `?s=`. So on hydration
 * this link re-tags itself with the remembered first-touch code (the same
 * exported reader the provider uses — no second validator). Progressive
 * enhancement: without JS the chooser still opens, only the body token is
 * dropped; the click is still counted by `cta_message_click`, which is an
 * internal navigation and deliberately NOT cta_text_click (no composer opened —
 * see lib/analytics/events.ts).
 */
export function ChooserLink({
  locale,
  placement,
  className,
  children,
}: {
  locale: Locale;
  placement: string;
  className?: string;
  children: React.ReactNode;
}) {
  const capture = useAnalytics();
  const base = localeHref(locale, '/text');
  const [href, setHref] = useState(base);

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
    if (code) setHref(`${base}?${SOURCE_CODE_PARAM}=${code}`);
  }, [base]);

  return (
    <a
      href={href}
      className={className}
      data-cta="cta_message_click"
      data-cta-placement={placement}
      onClick={() => capture('cta_message_click', { cta_placement: placement })}
    >
      {children}
    </a>
  );
}
