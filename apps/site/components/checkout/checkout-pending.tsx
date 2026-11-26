'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { POLL_INTERVAL_MS, POLL_WINDOW_MS, nextPollStep } from '~/lib/billing/checkout-poll';

/**
 * Waits for a payment to settle, one request at a time, for up to a minute.
 *
 * It asks the small status route rather than calling `router.refresh()` on every tick:
 * one failed app fetch during a refresh would render "no payment found" for a moment and
 * unmount this poller. It never reloads the page either, because each load sends a new
 * analytics PageView. A refresh that still renders pending keeps this component mounted,
 * so the loop carries on until the window closes.
 */
export function CheckoutPending({
  sessionId,
  lede,
  slowLede,
}: {
  sessionId: string;
  lede: string;
  slowLede: string;
}) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();

    async function readSettled(): Promise<boolean> {
      try {
        const res = await fetch(
          `/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return false;
        const body = (await res.json()) as { settled?: unknown };
        return body.settled === true;
      } catch {
        // A failed poll is the same as "not yet": the next tick asks again.
        return false;
      }
    }

    async function tick() {
      const settled = await readSettled();
      if (stopped) return;
      const elapsedMs = Date.now() - started;
      const step = nextPollStep({ settled, elapsedMs });
      if (step === 'refresh') router.refresh();
      if (step === 'expire' || elapsedMs >= POLL_WINDOW_MS) {
        setSlow(true);
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [sessionId, router]);

  return (
    <output
      className="hs-p"
      style={{ display: 'block', fontFamily: 'var(--font-ui)', color: 'var(--navy)' }}
    >
      {slow ? slowLede : lede}
    </output>
  );
}
