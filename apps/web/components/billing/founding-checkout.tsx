'use client';

import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, LockKeyhole } from 'lucide-react';
import {
  type Attribution,
  type BillingCurrency,
  CANADA_PLUS_AFTER_LINE,
  FOUNDING_PRICE_DISPLAY,
  type PromoPhase,
} from '@hale/types';
import styles from './founding-checkout.module.css';

interface Props {
  currency: BillingCurrency;
  phase: PromoPhase;
  /** A page without a configured price never offers a dead pay button. */
  ready: boolean;
  attribution: Attribution;
  /** Non-production visual review: never creates a Stripe session. */
  reviewOnly?: boolean;
  /** Back from Stripe's cancel link. */
  cancelled?: boolean;
}

const ERROR_TEXT: Record<string, string> = {
  unauthenticated: 'Please sign in again, then come back to this page.',
  no_family: 'Text Hale first so your family is ready, then come back to this page.',
  currency_changed:
    'Your location changed. Reload this page to check the price before you continue.',
  founding_unavailable: 'The founding offer isn’t available right now. Please try again later.',
  stripe_billing_not_live:
    'Checkout isn’t open yet. You haven’t been charged. Please try again later.',
  stripe_checkout_failed: 'We couldn’t open checkout. You haven’t been charged. Please try again.',
  not_found: 'Checkout isn’t open yet. You haven’t been charged. Please try again later.',
};

/**
 * A confirmation before Stripe: price, annual recurrence and the lifetime lock
 * are all visible before a parent taps through. The server route still owns the
 * currency, promo window and price id; nothing charged comes from this client.
 */
export function FoundingCheckout({
  currency,
  phase,
  ready,
  attribution,
  reviewOnly = false,
  cancelled = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const display = FOUNDING_PRICE_DISPLAY[currency];
  const saleName = phase === 'black_friday' ? 'Black Friday Sale' : 'Holiday Sale';

  async function begin() {
    if (busy || !ready) return;
    if (reviewOnly) {
      setError('This is the design preview. No checkout was created and nothing was charged.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          period: 'annual',
          offer: 'founding',
          expectedCurrency: currency,
          ...attribution,
        }),
      });
      const body = (await response.json()) as { url?: unknown; error?: unknown };
      if (response.ok && typeof body.url === 'string') {
        // Stripe is the only allowed off-origin next hop. Never navigate to an
        // arbitrary URL from a surprising API response.
        const next = new URL(body.url);
        if (next.protocol !== 'https:' || next.hostname !== 'checkout.stripe.com')
          throw new Error('bad_checkout_url');
        window.location.assign(next.href);
        return;
      }
      const key = typeof body.error === 'string' ? body.error : '';
      setError(
        ERROR_TEXT[key] ?? 'We couldn’t open checkout. You haven’t been charged. Please try again.',
      );
    } catch {
      setError(
        'We couldn’t reach checkout. You haven’t been charged. Check your connection and try again.',
      );
    }
    setBusy(false);
  }

  return (
    <section className={styles.card} aria-labelledby="founding-title">
      <a href="/settings/plan" className={styles.back}>
        <ArrowLeft aria-hidden="true" /> Your plan
      </a>
      <div className={styles.grid}>
        <div>
          <p className={styles.kicker}>Founding families</p>
          <h1 id="founding-title" className={styles.sale}>
            {saleName}
          </h1>
          <p className={styles.price} aria-label={`${display.perYear.replace('/yr', ' a year')}`}>
            <span className={styles.symbol} aria-hidden="true">
              {display.symbol}
            </span>
            <span className={styles.amount} aria-hidden="true">
              {display.amount}
            </span>
            <span className={styles.per} aria-hidden="true">
              /yr
            </span>
          </p>
          <p className={styles.lede}>
            Your founding price, locked in for as long as you’re a member.
          </p>
          <p className={styles.after}>
            Join by Dec 31. Refund anytime.{currency === 'CAD' ? ` ${CANADA_PLUS_AFTER_LINE}` : ''}
          </p>
        </div>
        <div className={styles.summary}>
          {cancelled ? (
            <output className={styles.cancelled}>
              Checkout closed before payment. You haven’t been charged.
            </output>
          ) : null}
          <h2>Before you continue</h2>
          <ul>
            <li>
              <Check aria-hidden="true" />
              <span>
                Billed {display.perYear} in {currency}, starting today.
              </span>
            </li>
            <li>
              <Check aria-hidden="true" />
              <span>Renews once a year at the same price while you stay subscribed.</span>
            </li>
            <li>
              <Check aria-hidden="true" />
              <span>
                Cancel or request a refund anytime at{' '}
                <a href="mailto:aloha@villagehale.com">aloha@villagehale.com</a>.
              </span>
            </li>
          </ul>
          <p className={styles.note}>
            If you cancel, the founding price ends with your membership. Your payment details go
            directly to Stripe.
          </p>
          {!ready ? (
            <output className={styles.error}>
              Checkout isn’t open yet. You haven’t been charged. Please try again later.
            </output>
          ) : null}
          <button type="button" className={styles.button} onClick={begin} disabled={busy || !ready}>
            {busy ? 'Opening checkout…' : `Continue to checkout · ${display.perYear}`}
            <ArrowRight aria-hidden="true" />
          </button>
          <p className={styles.secure}>
            <LockKeyhole aria-hidden="true" /> Secure checkout with Stripe. No charge until you
            confirm.
          </p>
          <output className={styles.error} aria-live="polite">
            {error}
          </output>
        </div>
      </div>
    </section>
  );
}
