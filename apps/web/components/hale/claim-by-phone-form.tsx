'use client';

import { ArrowRight } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { claimByPhoneAction } from '~/lib/auth/claim-phone-actions';

/**
 * Sign in with the number Hale already texts (F14). Two steps in one card: the number,
 * then the six digits we text back.
 *
 * THE COPY IS THE SECURITY BOUNDARY here as much as the endpoint is. The confirmation
 * after step one is written to be true for every number anyone could type — a parent's,
 * a stranger's, one that replied STOP — because the endpoint answers all three
 * identically and this screen must not undo that by phrasing it as "we sent you a
 * code" (rule #1: never confirm that a number has an account). The STOP hint is shown
 * to EVERYONE for the same reason: shown only to opted-out numbers, it would be an
 * oracle; shown to all, it is just the honest instruction for anyone it applies to.
 *
 * This flow assumes a signed-OUT visitor. A visitor already signed in under another
 * identity is untouched — linking a phone to an existing account is a separate,
 * consent-bearing decision and is deliberately not offered here.
 */
export function ClaimByPhoneForm({ callbackUrl = '' }: { callbackUrl?: string }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = phone.trim();
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/claim-phone/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: value }),
      });
      if (res.status === 429) {
        setError('Too many requests just now — wait a few minutes and try again.');
        return;
      }
      if (!res.ok) {
        setError("That didn't go through — check the number and try again.");
        return;
      }
      setStep('code');
    } catch {
      setError("That didn't go through — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // On success the action redirects and this never resolves.
      const result = await claimByPhoneAction(phone.trim(), value, callbackUrl);
      if (result.status === 'error') setError(result.message);
    } catch {
      setError("That didn't go through — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  if (step === 'code') {
    return (
      <form onSubmit={submitCode} className="flex w-full flex-col gap-2.5">
        <p className="text-slate-green leading-relaxed" aria-live="polite">
          If that number has an account with me, a six-digit code is on its way to it.
          Enter it here.
        </p>
        <div className="auth-field">
          <div className="auth-field-main">
            <label htmlFor="claim-code" className="auth-field-label">
              Code
            </label>
            <input
              id="claim-code"
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              className="auth-field-input"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
            />
          </div>
          <button
            type="submit"
            className="auth-submit"
            disabled={busy || code.trim().length === 0}
            aria-label={busy ? 'Checking your code' : 'Sign in with this code'}
            aria-live="polite"
          >
            <span className="auth-submit-ring" aria-hidden="true" />
            <ArrowRight size={20} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="meta">
          Nothing arrived? The code takes a moment. If you once replied STOP to my texts,
          reply START in that same conversation first — I can&rsquo;t text a number that
          asked me not to.
        </p>
        <button
          type="button"
          className="btn-ghost self-start"
          onClick={() => {
            setStep('phone');
            setCode('');
            setError(null);
          }}
        >
          Use a different number
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} className="flex w-full flex-col gap-2.5">
      <div className="auth-field">
        <div className="auth-field-main">
          <label htmlFor="claim-phone" className="auth-field-label">
            Phone
          </label>
          <input
            id="claim-phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            spellCheck={false}
            required
            className="auth-field-input"
            placeholder="(519) 555-1234"
            value={phone}
            onChange={(e) => setPhone(e.currentTarget.value)}
          />
        </div>
        <button
          type="submit"
          className="auth-submit"
          disabled={busy || phone.trim().length === 0}
          aria-label={busy ? 'Sending your code' : 'Text me a sign-in code'}
          aria-live="polite"
        >
          <span className="auth-submit-ring" aria-hidden="true" />
          <ArrowRight size={20} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="meta">
        If you started with me by text, this is your way in — I&rsquo;ll text a code to
        that number.
      </p>
    </form>
  );
}
