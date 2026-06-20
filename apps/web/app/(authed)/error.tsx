'use client';

import { useEffect } from 'react';

/**
 * Error boundary for the authed pages. A failed server read (e.g. a DB query that
 * errors once a database exists — deliberately NOT masked as "no data", see
 * lib/dashboard/queries.ts) surfaces here as a calm recoverable state with a
 * retry, rather than a blank screen or a raw stack. No error detail is rendered —
 * it can carry family data (rule #1) — only logged to the console for the dev.
 */
export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="rise rise-1">
      <section className="panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
        <span className="eyebrow">something went sideways</span>
        <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
          we couldn&rsquo;t load this just now.
        </p>
        <p className="meta text-slate-green max-w-xl mx-auto">
          your data is safe — this is on our end. give it another try, and if it keeps happening,
          it&rsquo;ll be waiting for you in a moment.
        </p>
        <div className="pt-2">
          <button type="button" className="btn-primary" onClick={reset}>
            try again
          </button>
        </div>
      </section>
    </div>
  );
}
