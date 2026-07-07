'use client';

import { useState } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { APP_URL } from '~/lib/app-url';

const FIELD_STYLE = {
  border: '1px solid var(--color-rule-strong)',
  background: 'var(--color-linen)',
  color: 'inherit',
} as const;

/**
 * The Plus/Family waitlist capture: email + neighbourhood + tier. Posts to the
 * app's /api/waitlist (the app owns the database; the site stays static). Only
 * the coarse `waitlist_signup` event reaches analytics — the email itself never
 * leaves the form except to the app (hard rule #1). The hidden `website` field
 * is a honeypot: humans never see it, so a filled value marks a bot.
 */
export function WaitlistSection() {
  const capture = useAnalytics();
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus('sending');
    try {
      const res = await fetch(`${APP_URL}/api/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.get('email'),
          neighbourhood: data.get('neighbourhood') || undefined,
          tier: data.get('tier'),
          website: data.get('website') || undefined,
        }),
      });
      if (!res.ok) throw new Error(`waitlist ${res.status}`);
      capture('waitlist_signup');
      setStatus('done');
    } catch {
      setStatus('error');
    }
  }

  return (
    <section id="waitlist" className="shell pb-24 lg:pb-32">
      <div className="panel-oat px-8 py-12 sm:px-14 sm:py-14">
        <div className="max-w-2xl">
          <span className="eyebrow">The waitlist</span>
          <h2 className="mt-3">Be first when Plus and Family open.</h2>
          <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
            Leave an email and a neighbourhood, pick a tier, and you&rsquo;re in line — founding
            families hear first. No marketing, just your spot.
          </p>
        </div>

        {status === 'done' ? (
          <p className="mt-8 font-display text-xl" style={{ color: 'var(--color-spruce)' }}>
            You&rsquo;re on the list — we&rsquo;ll email you when your tier opens.
          </p>
        ) : (
          <form
            onSubmit={submit}
            className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end"
          >
            <label className="flex min-w-[220px] flex-1 flex-col gap-2">
              <span className="meta">Email</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="rounded-full px-5 py-3"
                style={FIELD_STYLE}
              />
            </label>
            <label className="flex min-w-[180px] flex-1 flex-col gap-2">
              <span className="meta">Neighbourhood (optional)</span>
              <input
                name="neighbourhood"
                type="text"
                maxLength={120}
                autoComplete="off"
                placeholder="e.g. Georgetown"
                className="rounded-full px-5 py-3"
                style={FIELD_STYLE}
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="meta">Tier</span>
              <select
                name="tier"
                defaultValue="plus"
                className="rounded-full px-5 py-3"
                style={FIELD_STYLE}
              >
                <option value="plus">Plus</option>
                <option value="family">Family</option>
              </select>
            </label>
            <input
              name="website"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />
            <button type="submit" className="btn-primary" disabled={status === 'sending'}>
              {status === 'sending' ? 'Joining…' : 'Join the waitlist'}
            </button>
            {status === 'error' ? (
              <p role="alert" className="meta w-full">
                Something went wrong — try again in a minute.
              </p>
            ) : null}
          </form>
        )}
      </div>
    </section>
  );
}
