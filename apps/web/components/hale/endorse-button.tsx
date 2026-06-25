'use client';

import { Heart } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { endorsementLabel } from '~/lib/village/social-proof';

type State = 'idle' | 'pending' | 'endorsed' | 'error';

interface EndorseButtonProps {
  /** POST /api/village/:id/endorse — idempotent; first tap writes the audit row. */
  endpoint: string;
  /** Whether THIS family has already endorsed (server-resolved). */
  initiallyEndorsed: boolean;
  /** Aggregate distinct-family count (a count, never an identity — rule #1). */
  initialCount: number;
}

/**
 * The trusted-parent half of hybrid trust: a parent endorses a candidate the AI
 * surfaced. Optimistic but honest — pending while in flight, the fresh aggregate
 * count reflected on success, the error surfaced (never a silent success). Once
 * endorsed the control reads "you love this" and stays disabled (idempotent
 * server-side anyway). The social-proof line uses the same `endorsementLabel`
 * the public artifacts use, so the private and shared views agree.
 */
export function EndorseButton({ endpoint, initiallyEndorsed, initialCount }: EndorseButtonProps) {
  const [state, setState] = useState<State>(initiallyEndorsed ? 'endorsed' : 'idle');
  const [count, setCount] = useState(initialCount);
  const capture = useAnalytics();

  async function endorse() {
    setState('pending');
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      if (res.status !== 200) {
        setState('error');
        return;
      }
      const data = (await res.json()) as { count: number };
      setCount(data.count);
      capture('endorse');
      setState('endorsed');
    } catch {
      setState('error');
    }
  }

  const endorsed = state === 'endorsed';
  const proof = endorsementLabel(count);

  const label =
    state === 'pending'
      ? 'saving…'
      : endorsed
        ? 'you love this'
        : state === 'error'
          ? 'try again'
          : 'i love this';

  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="ghost"
        icon={Heart}
        onClick={endorse}
        disabled={state === 'pending' || endorsed}
        aria-live="polite"
        aria-pressed={endorsed}
      >
        {label}
      </Button>
      {proof ? <p className="meta text-apricot-deep">{proof}</p> : null}
      {state === 'error' ? (
        <p className="field-error" role="alert">
          couldn’t save that just now — try again.
        </p>
      ) : null}
    </div>
  );
}
