'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import stage from '~/components/hale/connect/connect.module.css';
import { DeviceTextLink } from '~/components/hale/device-text-link';
import styles from '~/components/portal/signin.module.css';
import {
  CLAIM_CODE_ERROR,
  CLAIM_CODE_TTL_MS,
  CLAIM_CONNECTION_ERROR,
  CLAIM_NUMBER_ERROR,
  CLAIM_RATE_LIMIT,
  claimFailureStep,
} from '~/lib/auth/claim-phone-copy';
import { formatClaimPhone } from '~/lib/auth/claim-phone-format';
import { PORTAL_INTAKE_PREFILL } from '~/lib/text-hale-target';

/**
 * Ads new-visitor founding join. Phone → OTP (the one allowed fixed SMS) →
 * Stripe Checkout. Hale does not text first after payment: the parent uses
 * Text Hale.
 */
export function FoundingJoinForm({
  priceLabel,
  smsNumber = '',
  cancelled = false,
}: {
  priceLabel: string;
  smsNumber?: string;
  cancelled?: boolean;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'expired' | 'paid'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [verified, setVerified] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step !== 'code' || expiresAt === null) return;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      setStep('expired');
      return;
    }
    const timer = window.setTimeout(() => setStep('expired'), remaining);
    return () => window.clearTimeout(timer);
  }, [step, expiresAt]);

  function openCodeStep() {
    setStep('code');
    setCode('');
    setError(null);
    setTries(0);
    setExpiresAt(Date.now() + CLAIM_CODE_TTL_MS);
  }

  async function requestCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const value = phone.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/promo/join/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: value }),
      });
      if (res.status === 429) {
        setError(CLAIM_RATE_LIMIT);
        return;
      }
      if (!res.ok) {
        setError(CLAIM_NUMBER_ERROR);
        return;
      }
      openCodeStep();
    } catch {
      setError(CLAIM_CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  async function openCheckout() {
    const checkout = await fetch(`/api/promo/join/checkout${window.location.search}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: '{}',
    });
    if (checkout.status === 409) {
      setStep('paid');
      return;
    }
    if (checkout.status === 401) {
      setVerified(false);
      setError(CLAIM_CODE_ERROR);
      return;
    }
    if (!checkout.ok) {
      setError(CLAIM_CONNECTION_ERROR);
      return;
    }
    const payload = (await checkout.json()) as { url?: string };
    if (typeof payload.url !== 'string' || payload.url.length === 0) {
      setError(CLAIM_CONNECTION_ERROR);
      return;
    }
    window.location.assign(payload.url);
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!verified) {
        const value = code.trim();
        if (value.length === 0) return;
        const verify = await fetch('/api/promo/join/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ phone: phone.trim(), code: value }),
        });
        if (verify.status === 429) {
          setError(CLAIM_RATE_LIMIT);
          return;
        }
        if (!verify.ok) {
          const next = tries + 1;
          setTries(next);
          if (claimFailureStep(next) === 'expired') {
            setStep('expired');
            setError(null);
          } else {
            setError(CLAIM_CODE_ERROR);
          }
          return;
        }
        const body = (await verify.json()) as { alreadyPaid?: boolean };
        if (body.alreadyPaid) {
          setStep('paid');
          return;
        }
        setVerified(true);
      }
      await openCheckout();
    } catch {
      setError(CLAIM_CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  function changeNumber() {
    setStep('phone');
    setCode('');
    setError(null);
    setTries(0);
    setExpiresAt(null);
    setVerified(false);
  }

  const CODE_SLOTS = ['1', '2', '3', '4', '5', '6'] as const;

  if (step === 'paid') {
    return (
      <section className={`${stage.card} ${stage.door}`}>
        <div className={stage.act}>
          <div className={styles.stack}>
            <p className={styles.eyebrow}>Founding family</p>
            <h1 className={stage.h1}>This number is already on a paid plan.</h1>
            <p className={stage.lede}>Text Hale to start. Hale will not text first.</p>
            <DeviceTextLink smsNumber={smsNumber} prefill={PORTAL_INTAKE_PREFILL} source={null}>
              Text Hale
            </DeviceTextLink>
          </div>
        </div>
      </section>
    );
  }

  const heading =
    step === 'expired'
      ? 'Time for a new code'
      : step === 'code'
        ? 'Check your texts'
        : 'Join as a founding family';
  const lede =
    step === 'expired'
      ? 'Codes work for 10 minutes or three tries. Send a fresh one to keep going.'
      : step === 'code'
        ? 'A code is on its way to this number.'
        : `${priceLabel}, locked for life. We’ll text you a code, then Stripe takes the payment. Hale will not text first.`;

  return (
    <section className={`${stage.card} ${stage.door}`}>
      <div className={stage.act}>
        <div className={styles.stack}>
          <p className={styles.eyebrow}>Founding family</p>
          <h1 className={stage.h1}>{heading}</h1>
          <p className={stage.lede}>{lede}</p>
          {cancelled ? (
            <p className={styles.alert}>
              Checkout was cancelled. You can try again from this page.
            </p>
          ) : null}

          {step === 'phone' ? (
            <form onSubmit={requestCode}>
              <div className={styles.field}>
                <label htmlFor="founding-phone">Mobile number</label>
                <input
                  id="founding-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  spellCheck={false}
                  required
                  className={`${styles.input} ph-mask ph-no-capture`}
                  data-hale-mask-input=""
                  data-hale-pii=""
                  placeholder="(555) 555-1234"
                  value={phone}
                  onChange={(e) => setPhone(formatClaimPhone(e.currentTarget.value))}
                />
              </div>
              {error ? (
                <p className={styles.alert} role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="submit"
                className={`${stage.btn} ${styles.full}`}
                disabled={busy || phone.trim().length === 0}
              >
                Text me a code
              </button>
            </form>
          ) : null}

          {step === 'code' ? (
            <form onSubmit={submitCode}>
              <p className={styles.sent}>
                <span>
                  Sent to <span data-hale-pii>{phone.trim()}</span>
                </span>
                <button type="button" onClick={changeNumber}>
                  Change
                </button>
              </p>
              <div className={styles.field}>
                <label htmlFor="founding-code">6-digit code</label>
                <div className={`${styles.codeWrap} ${error ? styles.bad : ''}`}>
                  <div className={styles.code} aria-hidden="true">
                    {CODE_SLOTS.map((slot, index) => (
                      <span
                        key={slot}
                        className={`${styles.box} ${index === code.length && code.length < 6 ? styles.on : ''}`}
                      >
                        {code[index] ?? ''}
                      </span>
                    ))}
                  </div>
                  <input
                    ref={codeRef}
                    id="founding-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    className={`${styles.codeInput} ph-mask ph-no-capture`}
                    data-hale-mask-input=""
                    data-hale-pii=""
                    aria-label="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                {error ? (
                  <p className={styles.err} role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
              <button
                type="submit"
                className={`${stage.btn} ${styles.full}`}
                disabled={busy || code.trim().length === 0}
              >
                Continue to checkout
              </button>
              <p className={styles.alt}>
                <span className={styles.muted}>{error ? 'Still stuck?' : 'Didn’t get it?'}</span>
                <button type="button" onClick={() => requestCode()} disabled={busy}>
                  Send a new code
                </button>
              </p>
            </form>
          ) : null}

          {step === 'expired' ? (
            <div>
              <button
                type="button"
                className={`${stage.btn} ${styles.full}`}
                disabled={busy}
                onClick={() => requestCode()}
              >
                Send a new code
              </button>
              <p className={styles.alt}>
                <span className={styles.muted}>Wrong number?</span>
                <button type="button" onClick={changeNumber}>
                  Use a different number
                </button>
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
