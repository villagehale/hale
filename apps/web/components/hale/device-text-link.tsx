'use client';

import { useEffect, useState } from 'react';
import { parsePortalSourceCode, platformFromUa, selectTextHaleHref } from '~/lib/text-hale-target';

/**
 * A "Text Hale" anchor in the portal.
 *
 * The server-rendered href is the marketing /text page (with `?s=` when the
 * server validated one), so no-JS and the first paint never dead-click an
 * `sms:` link. After hydration, iPhone, iPad, Mac, and Android retarget the
 * same anchor. The label does not change.
 */
export function DeviceTextLink({
  smsNumber,
  prefill,
  source = null,
  className,
  children,
}: {
  /** E.164, or '' when the line is not live — then the href stays on /text. */
  smsNumber: string;
  /** null opens the existing thread with no body. A string is the composer hello. */
  prefill: string | null;
  source?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  const [href, setHref] = useState(
    selectTextHaleHref({
      platform: 'unknown',
      smsNumber,
      prefill,
      source,
    }).href,
  );

  useEffect(() => {
    const fromUrl = parsePortalSourceCode(
      new URLSearchParams(window.location.search).get('s') ?? undefined,
    );
    const ua = typeof navigator === 'undefined' ? null : (navigator.userAgent ?? null);
    setHref(
      selectTextHaleHref({
        platform: platformFromUa(ua),
        smsNumber,
        prefill,
        source: fromUrl ?? source,
      }).href,
    );
  }, [smsNumber, prefill, source]);

  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
