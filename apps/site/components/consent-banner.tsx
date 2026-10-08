'use client';

import { useEffect, useId, useState } from 'react';
import {
  clearGoogleClickCookies,
  denyGoogleAds,
  installGoogleAds,
} from '~/lib/analytics/google-ads-client';
import { CONSENT_OPEN_EVENT, readConsent, writeConsent } from '~/lib/site/consent';

export function ConsentBanner({
  privacyHref,
  text,
  privacyLabel,
  rejectLabel,
  acceptLabel,
  regionLabel,
}: {
  privacyHref: string;
  text: string;
  privacyLabel: string;
  rejectLabel: string;
  acceptLabel: string;
  regionLabel: string;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (readConsent() === 'granted') installGoogleAds();
    const onOpen = () => setOpen(true);
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
  }, []);

  function accept() {
    const previous = readConsent();
    if (!writeConsent('granted')) return;
    setOpen(false);
    if (previous !== 'granted') installGoogleAds();
  }

  function reject() {
    const previous = readConsent();
    if (!writeConsent('denied')) return;
    setOpen(false);
    if (previous !== 'granted') return;
    denyGoogleAds();
    clearGoogleClickCookies();
    void import('posthog-js')
      .then(({ default: posthog }) => {
        if (posthog.__loaded) posthog.opt_out_capturing();
      })
      .finally(() => {
        window.location.reload();
      });
  }

  return (
    <section
      className={open ? 'consent-banner is-open' : 'consent-banner'}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="consent-vh">
        {regionLabel}
      </h2>
      <p className="consent-text">
        {text}{' '}
        <a href={privacyHref}>{privacyLabel}</a>
      </p>
      <div className="consent-actions">
        <button type="button" onClick={reject}>
          {rejectLabel}
        </button>
        <button type="button" onClick={accept}>
          {acceptLabel}
        </button>
      </div>
    </section>
  );
}
