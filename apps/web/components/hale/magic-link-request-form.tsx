'use client';

import { ArrowRight } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/**
 * Passwordless sign-in request: an email field + submit that POSTs to
 * /api/auth/magic-link/request. The endpoint mints a single-use link for ANY valid
 * address (sign-in doubles as sign-up) and ALWAYS returns the same body whether or
 * not an account exists (rule #1 — anti-enumeration), so the success copy here is
 * identical in both cases and never reveals account existence.
 *
 * Shared by /sign-in, /sign-up, and onboarding step 6 (the auth hop). `onSent`
 * lets a caller react once the link is on its way (e.g. persist pre-auth intake).
 * `variant` is presentation only — the endpoint call, anti-enumeration behavior,
 * and states are identical: 'stacked' (default) is the onboarding field + full-width
 * button; 'inline' is the auth-card field container with a circular submit.
 */
export function MagicLinkRequestForm({
  onSent,
  variant = 'stacked',
}: {
  onSent?: (email: string) => void;
  variant?: 'stacked' | 'inline';
}) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = email.trim();
    if (value.length === 0) {
      return;
    }
    setState({ kind: 'sending' });
    onSent?.(value);
    try {
      const res = await fetch('/api/auth/magic-link/request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      if (res.status === 429) {
        setState({
          kind: 'error',
          message: 'Too many requests just now — wait a minute and try again.',
        });
        return;
      }
      if (!res.ok) {
        setState({
          kind: 'error',
          message: "That didn't go through — check the address and try again.",
        });
        return;
      }
      setState({ kind: 'sent' });
    } catch {
      setState({
        kind: 'error',
        message: "That didn't go through — check your connection and try again.",
      });
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className="flex w-full flex-col gap-2" aria-live="polite">
        <p className="text-slate-green leading-relaxed">
          Check your inbox — I sent a sign-in link to <strong>{email.trim()}</strong>. Open it on
          this device to continue.
        </p>
        <button
          type="button"
          className="btn-ghost self-start"
          onClick={() => setState({ kind: 'idle' })}
        >
          Use a different email
        </button>
      </div>
    );
  }

  const disabled = state.kind === 'sending' || email.trim().length === 0;

  if (variant === 'inline') {
    return (
      <form onSubmit={submit} className="flex w-full flex-col gap-2.5">
        <div className="auth-field">
          <div className="auth-field-main">
            <label htmlFor="magic-email" className="auth-field-label">
              Email
            </label>
            <input
              id="magic-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="auth-field-input"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <button
            type="submit"
            className="auth-submit"
            disabled={disabled}
            aria-label={state.kind === 'sending' ? 'Sending sign-in link' : 'Email me a sign-in link'}
            aria-live="polite"
          >
            <span className="auth-submit-ring" aria-hidden="true" />
            <ArrowRight size={20} strokeWidth={2.4} aria-hidden="true" />
          </button>
        </div>
        {state.kind === 'error' ? (
          <p className="field-error" role="alert">
            {state.message}
          </p>
        ) : null}
        <p className="meta">We&rsquo;ll email you a magic sign-in link — no password needed.</p>
      </form>
    );
  }

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-3">
      <div className="field-group">
        <label htmlFor="magic-email" className="field-label">
          Email
        </label>
        <input
          id="magic-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="field"
          placeholder="you@email.com"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </div>
      {state.kind === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <button
        type="submit"
        className="btn-secondary justify-center"
        disabled={disabled}
        aria-live="polite"
      >
        {state.kind === 'sending' ? 'Sending…' : 'Email me a link'}
      </button>
      <p className="meta">We&rsquo;ll email you a magic sign-in link — no password needed.</p>
    </form>
  );
}
