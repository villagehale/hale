'use client';

import { useState } from 'react';
import stage from '~/components/hale/connect/connect.module.css';
import styles from './signin.module.css';

export function PlanCheckoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ period: 'annual' }),
      });
      if (res.status === 409) {
        setError('This family already has a paid plan.');
        return;
      }
      if (!res.ok) {
        setError('Checkout is not available right now.');
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (typeof body.url !== 'string' || body.url.length === 0) {
        setError('Checkout is not available right now.');
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError('Checkout is not available right now.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        className={`${stage.btn} ${styles.full}`}
        disabled={busy}
        onClick={start}
      >
        {busy ? 'Opening checkout' : 'Continue to checkout'}
      </button>
      {error ? (
        <p className={styles.alert} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
