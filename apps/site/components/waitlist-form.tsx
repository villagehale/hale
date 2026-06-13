'use client';

import { useState, type FormEvent } from 'react';

type Status = 'idle' | 'submitting' | 'done' | 'error';

export function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('submitting');
    setMessage('');

    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    if (res.ok) {
      setStatus('done');
      return;
    }

    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    setStatus('error');
    setMessage(data?.error ?? 'something went wrong — please try again');
  }

  if (status === 'done') {
    return (
      <div className="flex flex-col gap-3">
        <p className="font-display text-3xl" style={{ color: 'var(--color-spruce)' }}>
          you&rsquo;re on the list.
        </p>
        <output className="meta">
          we&rsquo;ll write to you when the early cohort opens. nothing else, ever.
        </output>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <label htmlFor="waitlist-email" className="eyebrow">
        Request early access
      </label>
      <div className="flex flex-col sm:flex-row gap-3">
        <input
          id="waitlist-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={status === 'error'}
          aria-describedby="waitlist-note"
          className="field sm:flex-1"
        />
        <button type="submit" className="btn-primary" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'adding…' : 'join the waitlist'}
        </button>
      </div>
      {status === 'error' && (
        <p className="meta" role="alert" style={{ color: 'var(--color-berry)' }}>
          {message}
        </p>
      )}
      <p id="waitlist-note" className="meta">
        a research preview — not a launched product. we email you only about early
        access and never share your address. (CASL)
      </p>
    </form>
  );
}
