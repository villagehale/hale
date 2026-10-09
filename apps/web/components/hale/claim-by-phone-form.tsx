'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import stage from '~/components/hale/connect/connect.module.css';
import styles from '~/components/portal/signin.module.css';
import { claimByPhoneAction } from '~/lib/auth/claim-phone-actions';
import {
  CLAIM_CODE_ERROR,
  CLAIM_CODE_TTL_MS,
  CLAIM_CONNECTION_ERROR,
  CLAIM_NUMBER_ERROR,
  CLAIM_RATE_LIMIT,
  claimFailureStep,
} from '~/lib/auth/claim-phone-copy';
import { formatClaimPhone } from '~/lib/auth/claim-phone-format';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * Sign in with the number Hale already texts (F14). Two steps in one glass card:
 * the number, then six digits.
 *
 * THE COPY IS THE SECURITY BOUNDARY here as much as the endpoint is. The line
 * after step one is true for every number anyone could type — a parent's, a
 * stranger's, one that replied STOP — because the endpoint answers all three
 * identically. The STOP hint is shown to EVERYONE for the same reason.
 *
 * "Time for a new code" is a client clock (10 minutes) and a local try count
 * (three). The server still answers every failed verify with one message, so
 * this screen cannot tell a real account from any other number.
 *
 * This flow assumes a signed-OUT visitor. Linking a phone to an existing
 * account is a separate, consent-bearing decision and is not offered here.
 */
export function ClaimByPhoneForm({ callbackUrl = '' }: { callbackUrl?: string }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code' | 'expired'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
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
      const res = await fetch('/api/auth/claim-phone/request', {
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

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await claimByPhoneAction(phone.trim(), value, callbackUrl);
      if (result.status === 'error') {
        if (result.message === CLAIM_CODE_ERROR) {
          const next = tries + 1;
          setTries(next);
          if (claimFailureStep(next) === 'expired') {
            setStep('expired');
            setError(null);
          } else {
            setError(result.message);
          }
        } else {
          setError(result.message);
        }
      }
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
  }

  const CODE_SLOTS = ['1', '2', '3', '4', '5', '6'] as const;

  const heading =
    step === 'expired'
      ? 'Time for a new code'
      : step === 'code'
        ? 'Check your texts'
        : 'Welcome back';
  const lede =
    step === 'expired'
      ? 'Codes work for 10 minutes or three tries. Send a fresh one to keep going.'
      : step === 'code'
        ? 'If this number has a Hale account, a code is on its way.'
        : 'Use the number you text Hale from. We’ll text you a code.';

  return (
    <section className={`${stage.card} ${stage.door}`}>
      <div className={stage.act}>
        <div className={styles.stack}>
          <p className={styles.eyebrow}>Sign in</p>
          <h1 className={stage.h1}>{heading}</h1>
          <p className={stage.lede}>{lede}</p>

          {step === 'phone' ? (
            <form onSubmit={requestCode}>
              <div className={styles.field}>
                <label htmlFor="claim-phone">Mobile number</label>
                <input
                  id="claim-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  spellCheck={false}
                  required
                  className={styles.input}
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
                {busy ? 'Text me a code' : 'Text me a code'}
              </button>
              <p className={styles.new}>
                New to Hale? <a href={`${MARKETING_SITE_URL}/text`}>Text Hale to start</a>
              </p>
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
                <label htmlFor="claim-code">6-digit code</label>
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
                    id="claim-code"
                    name="code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    required
                    className={styles.codeInput}
                    aria-label="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                  />
                </div>
                {error ? (
                  <p className={styles.err} role="alert">
                    <AlertIcon />
                    <span>{error}</span>
                  </p>
                ) : null}
              </div>
              <button
                type="submit"
                className={`${stage.btn} ${styles.full}`}
                disabled={busy || code.trim().length === 0}
              >
                {error ? 'Try again' : 'Sign in'}
              </button>
              <p className={styles.alt}>
                <span className={styles.muted}>{error ? 'Still stuck?' : 'Didn’t get it?'}</span>
                <button type="button" onClick={() => requestCode()} disabled={busy}>
                  Send a new code
                </button>
              </p>
              {error ? null : (
                <p className={styles.note}>
                  <InfoIcon />
                  <span>
                    Nothing yet? It can take a minute. If you once replied STOP to Hale, reply START
                    in that thread first.
                  </span>
                </p>
              )}
            </form>
          ) : null}

          {step === 'expired' ? (
            <div>
              <p className={styles.sent}>
                <span>
                  Sent to <span data-hale-pii>{phone.trim()}</span>
                </span>
                <button type="button" onClick={changeNumber}>
                  Change
                </button>
              </p>
              <div className={styles.field}>
                <span>6-digit code</span>
                <div className={`${styles.code} ${styles.dim}`} aria-hidden="true">
                  {CODE_SLOTS.map((slot) => (
                    <span key={slot} className={styles.box} />
                  ))}
                </div>
              </div>
              {error ? (
                <p className={styles.alert} role="alert">
                  {error}
                </p>
              ) : null}
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

function InfoIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5" strokeLinecap="round" />
      <path d="M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5" strokeLinecap="round" />
      <path d="M12 16h.01" strokeLinecap="round" />
    </svg>
  );
}
