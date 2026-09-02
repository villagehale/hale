import type { Metadata } from 'next';
import { AuthShell } from '~/components/hale/auth-shell';
import { ChannelLinkRedeem } from '~/components/hale/channel-link-redeem';
import { authConfigured } from '~/lib/auth-config';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect · Hale',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ t?: string }>;
}

/**
 * Redeem landing for the texted connect link (/connect?t=…). The token is spent only
 * when the client component's button submits it, in the server action — this page
 * render never consumes it, so a carrier link-scanner's GET costs the parent nothing.
 * A missing token gets the calm dead-end: the fresh link is one text away.
 */
export default async function ConnectPage({ searchParams }: PageProps) {
  const { t } = await searchParams;

  if (!authConfigured() || !t) {
    return (
      <AuthShell heading="Connect your apps">
        <p className="meta">
          This link is missing or incomplete. Text Hale &ldquo;connect my calendar&rdquo; and a
          fresh one arrives in a moment.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Connect your apps">
      <ChannelLinkRedeem token={t} />
    </AuthShell>
  );
}
