import type { Metadata } from 'next';
import { AuthShell } from '~/components/hale/auth-shell';
import { connectedNotice } from '~/lib/channel/connect/text-connect';

// The query is per-request, so keep it out of the static cache.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ provider?: string; status?: string; who?: string; lang?: string }>;
}

export const metadata: Metadata = {
  title: 'Connected · Hale',
  robots: { index: false, follow: false },
};

/**
 * GET /connected — the end of a connect the parent started in a text thread.
 *
 * ITS WHOLE JOB IS TO BE CLOSEABLE. No auth, no DB read, no PII, and deliberately no way
 * onward: the callback already verified the signed state and stored the connection, the
 * receipt is a text arriving on the same phone, and a link to Settings here would put
 * the portal back in the path the founder asked to take it out of.
 *
 * The query carries a provider slug and a status word and nothing else; both are
 * allowlisted in connect/text-connect.ts, which also owns the words — the page and the
 * text say the same thing about the same connection because they read the same module.
 */
export default async function ConnectedPage({ searchParams }: PageProps) {
  const { provider, status, who, lang } = await searchParams;
  const notice = connectedNotice(status, provider, {
    name: who,
    language: lang === 'fr' ? 'fr' : 'en',
  });

  return (
    <AuthShell heading={notice.heading}>
      <p className="meta">{notice.body}</p>
    </AuthShell>
  );
}
