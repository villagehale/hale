import type { Metadata } from 'next';
import { db } from '~/lib/db';
import { type UnsubscribeResult, processUnsubscribe } from '~/lib/cron/email-compliance';

// Node runtime: verifying the unsubscribe signature uses node:crypto, and the
// opt-out is written through the Drizzle client — neither works on the edge.
export const runtime = 'nodejs';
// The page writes (records the opt-out) on load, so it must never be cached.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ u?: string; t?: string; sig?: string }>;
}

export const metadata: Metadata = {
  title: 'Unsubscribe · Hale',
  robots: { index: false, follow: false },
};

/** One-click unsubscribe (CASL). The link in every digest email lands here; we
 * verify the signature and record the opt-out on load. No DATABASE_URL (static
 * preview) → treat as invalid rather than fabricating success. */
async function unsubscribe(params: { u?: string; t?: string; sig?: string }): Promise<UnsubscribeResult> {
  if (!process.env.DATABASE_URL) {
    return { status: 'invalid' };
  }
  return processUnsubscribe(db(), { u: params.u, t: params.t, sig: params.sig });
}

export default async function UnsubscribePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const result = await unsubscribe(params);

  const heading =
    result.status === 'unsubscribed'
      ? "you're unsubscribed."
      : "we couldn't process that link.";
  const detail =
    result.status === 'unsubscribed'
      ? "You won't receive daily brief emails anymore. You can still see your brief in the app, and account or security emails are unaffected."
      : 'The link may have expired or been mistyped. If you keep getting emails you did not expect, contact privacy@villagehale.com.';

  return (
    <main className="min-h-screen bg-spruce text-on-spruce flex items-center justify-center px-6 py-24">
      <div className="max-w-xl text-center space-y-6">
        <p className="eyebrow text-on-spruce-soft">Hale</p>
        <h1 className="font-display text-[2rem] lg:text-[2.75rem] text-on-spruce">{heading}</h1>
        <p className="text-lg text-on-spruce-soft leading-relaxed">{detail}</p>
      </div>
    </main>
  );
}
