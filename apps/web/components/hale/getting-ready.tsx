'use client';

import { useEffect, useRef, useState } from 'react';
import { TurtleLoader } from '~/components/hale/turtle-loader';
import type { MobileVillageResponse } from '~/app/api/mobile/types';
import {
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  type PollState,
  nextPollState,
} from '~/lib/onboarding/village-poll';

/**
 * The "getting things ready" moment — shown in-page after completeOnboarding
 * succeeds, while the background first-village discovery runs (discoveryTrigger).
 * The turtle breathes with staged copy and POLLS THE REAL VILLAGE READ
 * (GET /api/mobile/village, the same loadVillage the /village page reads) every
 * ~3s until candidates land or a ~45s window elapses. It NEVER shows a fake
 * progress bar and NEVER invents a count — the ready line reports exactly what the
 * read returned. On timeout it says so honestly and lets the parent continue.
 */

const WAIT_LINES = [
  'looking for the people and places near you…',
  'reading your neighbourhood…',
  'gathering what your village recommends…',
] as const;

export function GettingReady({
  area,
  onContinue,
}: {
  /** The coarse area the parent just entered (city / area) — for the ready line.
   * Never a precise address (rule #1). Empty when unknown. */
  area: string;
  onContinue: () => void;
}) {
  const [state, setState] = useState<PollState>({ kind: 'waiting' });
  const [lineIndex, setLineIndex] = useState(0);
  // Advancing to this view unmounts the consent button, so without a focus target
  // keyboard/SR focus would drop to <body> and the page would have no heading.
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    async function poll(): Promise<void> {
      let count = 0;
      try {
        const res = await fetch('/api/mobile/village', { cache: 'no-store' });
        if (res.ok) {
          const body = (await res.json()) as MobileVillageResponse;
          count = body.candidates.length;
        }
      } catch {
        // A transient read failure is treated as "not ready yet" — the next tick
        // retries, and the timeout still bounds the wait. Nothing to surface.
      }
      if (cancelled) {
        return;
      }
      const next = nextPollState(count, Date.now() - startedAt);
      setState(next);
      if (next.kind === 'waiting') {
        timer = window.setTimeout(poll, POLL_INTERVAL_MS);
      }
    }

    let timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    // A hard ceiling independent of read latency, so a stalled fetch never leaves
    // the parent stranded on the loader past the window.
    const ceiling = window.setTimeout(() => {
      if (!cancelled) {
        setState((s) => (s.kind === 'waiting' ? { kind: 'timeout' } : s));
      }
    }, POLL_TIMEOUT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(ceiling);
    };
  }, []);

  useEffect(() => {
    if (state.kind !== 'waiting') {
      return;
    }
    const rotate = window.setInterval(
      () => setLineIndex((i) => (i + 1) % WAIT_LINES.length),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(rotate);
  }, [state.kind]);

  const near = area.trim() ? ` near ${area.trim()}` : '';

  return (
    <section className="rise rise-1 flex min-h-[60vh] flex-col items-center justify-center text-center">
      <h1 ref={headingRef} tabIndex={-1} className="sr-only outline-none">
        getting things ready
      </h1>
      {state.kind === 'waiting' ? (
        <>
          <TurtleLoader label="setting up your family" />
          <p className="meta mt-2" aria-live="polite">
            {WAIT_LINES[lineIndex]}
          </p>
        </>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <TurtleLoader label="your village is ready" />
          <p className="mt-4 text-lg text-spruce leading-relaxed">
            {state.count} {state.count === 1 ? 'thing' : 'things'} found{near}.
          </p>
          <button type="button" className="btn-primary mt-8" onClick={onContinue}>
            open my home →
          </button>
        </>
      ) : null}

      {state.kind === 'timeout' ? (
        <>
          <TurtleLoader label="still looking" />
          <p className="mt-4 text-lg text-slate-green leading-relaxed max-w-md">
            This is taking a little longer — your village keeps filling in in the
            background; check it from your home.
          </p>
          <button type="button" className="btn-primary mt-8" onClick={onContinue}>
            open my home →
          </button>
        </>
      ) : null}
    </section>
  );
}
