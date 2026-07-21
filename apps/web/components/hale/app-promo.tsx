'use client';

import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogoMark } from '~/components/hale/logo-mark';
import {
  APP_PROMO_CHOICE_KEY,
  type AppPromoChoice,
  appPromoPhase,
  parseAppPromoChoice,
} from './app-promo-core';

/** The phone breakpoint for the hand-off, matching the design's own probe
 * (`max-width: 767px`). Below 768px the desktop chrome (min-width 1180px) is a poor
 * fit, so we invite the app; at ≥768px the promo never mounts (no layout shift). */
const PHONE_QUERY = '(max-width: 767.98px)';

/**
 * The <768px app hand-off (design handoff §5). Mounted once in the root layout so
 * it covers the authed shell AND the public auth pages. Honesty gate: the whole
 * surface renders nothing unless NEXT_PUBLIC_APP_PROMO_URL is set — there is no
 * App-Store URL yet, and a dead "Open app" link is forbidden. Both Open controls
 * point at that URL.
 */
export function AppPromo() {
  const url = process.env.NEXT_PUBLIC_APP_PROMO_URL;
  if (!url) return null;
  return <AppPromoInner url={url} />;
}

function AppPromoInner({ url }: { url: string }) {
  // Start hidden so the server render and first client paint agree (the phone probe
  // + stored choice only exist client-side); the effects correct it after mount.
  const [isPhone, setIsPhone] = useState(false);
  const [choice, setChoice] = useState<AppPromoChoice | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    try {
      setChoice(parseAppPromoChoice(sessionStorage.getItem(APP_PROMO_CHOICE_KEY)));
    } catch {
      // Storage can be unavailable (private mode / disabled) — treat as a first
      // visit rather than crashing the whole shell over a promo.
    }
  }, []);

  function choose(next: AppPromoChoice) {
    try {
      sessionStorage.setItem(APP_PROMO_CHOICE_KEY, next);
    } catch {
      // Best-effort session persistence; the in-memory state below still advances.
    }
    setChoice(next);
  }

  const phase = appPromoPhase(url, isPhone, choice);
  if (phase === 'sheet') return <AppPromoSheet url={url} onContinue={() => choose('web')} />;
  if (phase === 'banner') return <AppPromoBanner url={url} onDismiss={() => choose('dismissed')} />;
  return null;
}

export function AppPromoSheet({ url, onContinue }: { url: string; onContinue: () => void }) {
  return (
    <div className="apppromo-scrim">
      <div
        className="apppromo-sheet"
        // biome-ignore lint/a11y/useSemanticElements: a promo bottom-sheet dialog, matching the app's hand-rolled Modal role rather than the native <dialog> element
        role="dialog"
        aria-modal="true"
        aria-labelledby="apppromo-title"
      >
        <LogoMark size={56} className="apppromo-logo" />
        <p id="apppromo-title" className="apppromo-title">
          Hale is better in the app
        </p>
        <p className="apppromo-sub">
          Faster logging, notifications for approvals, and your village on the go.
        </p>
        <a href={url} className="apppromo-primary">
          Open app
        </a>
        <button type="button" className="apppromo-secondary" onClick={onContinue}>
          Continue in browser
        </button>
      </div>
    </div>
  );
}

export function AppPromoBanner({ url, onDismiss }: { url: string; onDismiss: () => void }) {
  return (
    <section className="apppromo-banner" aria-label="Get the Hale app">
      <span className="apppromo-banner-text">Hale works best in the app</span>
      <a href={url} className="apppromo-banner-open">
        Open
      </a>
      <button
        type="button"
        className="apppromo-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X size={16} aria-hidden />
      </button>
    </section>
  );
}
