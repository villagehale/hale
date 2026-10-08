'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  clearGoogleClickCookies,
  denyGoogleAds,
  installGoogleAds,
} from '~/lib/analytics/google-ads-client';
import { CONSENT_OPEN_EVENT, readConsent, writeConsent } from '~/lib/site/consent';

/** Keeps the last ZH clause on one line so a single character is not stranded. */
const ZH_UNBROKEN = '什么都不会加载。';

function ConsentSentence({ text }: { text: string }): ReactNode {
  const at = text.indexOf(ZH_UNBROKEN);
  if (at === -1) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="consent-nowrap">{ZH_UNBROKEN}</span>
      {text.slice(at + ZH_UNBROKEN.length)}
    </>
  );
}

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
        <ConsentSentence text={text} />
        <span className="consent-inline">
          {' '}
          <a href={privacyHref}>{privacyLabel}</a>
        </span>
      </p>
      <div className="consent-actions">
        <a className="consent-policy" href={privacyHref}>
          {privacyLabel}
        </a>
        <button type="button" className="is-reject" onClick={reject}>
          {rejectLabel}
        </button>
        <button type="button" className="is-accept" onClick={accept}>
          {acceptLabel}
        </button>
      </div>
    </section>
  );
}
