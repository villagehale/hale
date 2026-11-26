'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';
import {
  clearGoogleClickCookies,
  denyGoogleAds,
  installGoogleAds,
} from '~/lib/analytics/google-ads-client';
import { parseMetaPixelIds } from '~/lib/analytics/meta-pixel';
import {
  clearMetaClickCookies,
  denyMetaPixel,
  installMetaPixel,
} from '~/lib/analytics/meta-pixel-client';
import { hasSecretQuery } from '~/lib/analytics/url-secrets';
import {
  CONSENT_OPEN_EVENT,
  CONSENT_STORAGE_KEY,
  type ConsentChoice,
  browserGlobalPrivacyControl,
  markMeasurementStarted,
  measurementStartedHere,
  readConsent,
  readStoredConsent,
  refuseMeasurementHere,
  writeConsent,
} from '~/lib/site/consent';
import type { ConsentMode } from '~/lib/site/consent-region';

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

function pageCarriesSecret(): boolean {
  if (typeof window === 'undefined') return false;
  return hasSecretQuery(window.location.search) || hasSecretQuery(window.location.hash);
}

function shutdownTrackers(reload: boolean): void {
  denyGoogleAds();
  clearGoogleClickCookies();
  denyMetaPixel();
  clearMetaClickCookies();
  void import('posthog-js')
    .then(({ default: posthog }) => {
      if (posthog.__loaded) posthog.opt_out_capturing();
    })
    .finally(() => {
      if (reload) window.location.reload();
    });
}

function pixelIdsFromPropsOrEnv(pixelId: string | null | undefined): readonly string[] {
  if (pixelId) return parseMetaPixelIds(pixelId);
  if (process.env.NEXT_PUBLIC_CONVERSIONS_API_ENABLED !== 'true') return [];
  return parseMetaPixelIds(process.env.NEXT_PUBLIC_META_PIXEL_ID);
}

export function ConsentBanner({
  privacyHref,
  text,
  notice,
  privacyLabel,
  rejectLabel,
  turnOffLabel,
  acceptLabel,
  regionLabel,
  mode,
  gpc,
  pixelId = null,
}: {
  privacyHref: string;
  /** Opt-in copy: nothing loads until Accept. */
  text: string;
  /** Opt-out copy: measurement is already on. */
  notice: string;
  privacyLabel: string;
  rejectLabel: string;
  turnOffLabel: string;
  acceptLabel: string;
  regionLabel: string;
  mode: ConsentMode;
  /** Sec-GPC from the request. The browser flag is read before anything loads. */
  gpc: boolean;
  pixelId?: string | null;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [browserGpc, setBrowserGpc] = useState(false);
  const [persistable, setPersistable] = useState(true);
  const [pageBlocked, setPageBlocked] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.consentMode = mode;
    const navGpc = browserGlobalPrivacyControl();
    if (gpc || navGpc) document.documentElement.dataset.gpc = '1';
    else document.documentElement.removeAttribute('data-gpc');
    if (navGpc) setBrowserGpc(true);
    const stored = readStoredConsent();
    setStorageBlocked(stored.blocked);
    setChoice(stored.choice);
    const secret = pageCarriesSecret();
    setPageBlocked(secret);
    const allowed = readConsent() === 'granted';
    setPersistable(allowed || readStoredConsent().choice === 'granted');
    const ids = pixelIdsFromPropsOrEnv(pixelId);
    if (allowed && !secret) {
      installGoogleAds();
      if (ids.length > 0) installMetaPixel(ids);
      markMeasurementStarted();
    }
    const onOpen = () => setOpen(true);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== CONSENT_STORAGE_KEY || event.newValue !== 'denied') return;
      if (!measurementStartedHere()) return;
      setChoice('denied');
      shutdownTrackers(true);
    };
    window.addEventListener(CONSENT_OPEN_EVENT, onOpen);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CONSENT_OPEN_EVENT, onOpen);
      window.removeEventListener('storage', onStorage);
    };
  }, [pixelId, mode, gpc]);

  function accept() {
    const previous = readConsent();
    if (!writeConsent('granted')) return;
    setChoice('granted');
    setOpen(false);
    if (previous !== 'granted') {
      installGoogleAds();
      const ids = pixelIdsFromPropsOrEnv(pixelId);
      if (ids.length > 0) installMetaPixel(ids);
    }
  }

  function reject() {
    // This document may already be measuring while another tab stored the
    // refusal. The shared value is then `denied`, so the decision to stop
    // follows what this document started, not that stored value.
    const measuring = readConsent() === 'granted' || measurementStartedHere();
    const saved = writeConsent('denied');
    if (!saved) {
      if (!measuring) return;
      refuseMeasurementHere();
      setChoice('denied');
      setOpen(false);
      shutdownTrackers(false);
      return;
    }
    setChoice('denied');
    setOpen(false);
    if (!measuring) return;
    shutdownTrackers(true);
  }

  const measuring =
    !storageBlocked &&
    persistable &&
    !pageBlocked &&
    (choice === 'granted' || (choice === null && mode === 'opt-out' && !gpc && !browserGpc));

  return (
    <section
      className={open ? 'consent-banner is-open' : 'consent-banner'}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="consent-vh">
        {regionLabel}
      </h2>
      <p className="consent-text">
        <ConsentSentence text={measuring ? notice : text} />
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
          {measuring ? turnOffLabel : rejectLabel}
        </button>
        <button type="button" className="is-accept" onClick={accept}>
          {acceptLabel}
        </button>
      </div>
    </section>
  );
}
