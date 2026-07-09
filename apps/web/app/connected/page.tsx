import type { Metadata } from 'next';

// A tiny public status page (no auth, no DB): the mobile connect flow's callback
// redirect target. Nothing to render dynamically that a CDN couldn't cache, but the
// query is per-request, so keep it out of the static cache.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ provider?: string; status?: string }>;
}

export const metadata: Metadata = {
  title: 'Connected · Hale',
  robots: { index: false, follow: false },
};

/** Friendly names for the connector providers — the query carries the slug only
 * (never PII); an unknown slug falls back to the generic copy. */
const PROVIDER_LABELS: Record<string, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
  gdrive: 'Google Drive',
};

/**
 * GET /connected — where the mobile connector flow's callback lands after the
 * user grants (or denies) Google consent in a browser. No auth and no PII: the
 * callback already verified the signed state and stored the connection; this page
 * only tells the user it's done so they can return to the app. On success the query
 * carries the provider slug (?provider=gcal); on failure a status flag (?status=).
 */
export default async function ConnectedPage({ searchParams }: PageProps) {
  const { provider, status } = await searchParams;
  const succeeded = !status && provider !== undefined;

  const label = provider ? PROVIDER_LABELS[provider] : undefined;
  const heading = succeeded ? 'connected.' : "we couldn't connect that.";
  const detail = succeeded
    ? `${label ?? 'Your account'} is linked. Return to the Hale app — it's ready to use.`
    : 'Something went wrong, or the request expired. Head back to the Hale app and try connecting again.';

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
