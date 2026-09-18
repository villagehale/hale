import type { Metadata } from 'next';
import { AuthShell } from '~/components/hale/auth-shell';
import { ChannelLinkRedeem } from '~/components/hale/channel-link-redeem';
import { authConfigured } from '~/lib/auth-config';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect · Hale',
  robots: { index: false, follow: false },
};

interface PageProps {
  searchParams: Promise<{ t?: string; to?: string }>;
}

/**
 * Redeem landing for the texted connect link (/connect?t=…&to=gcal). The token is spent
 * only when the client component's button submits it, in the server action — this page
 * render never consumes it, so a carrier link-scanner's GET costs the parent nothing.
 * A missing token gets the calm dead-end: the fresh link is one text away.
 *
 * `to` names which connector the link was texted for, so the one tap it already asks for
 * is also the last one: the redemption forwards straight into Google's consent instead
 * of into Settings. It is read through the allowlist, never used as a path — an
 * unrecognised value is not an error a parent has to read, just the flow as it was.
 */
export default async function ConnectPage({ searchParams }: PageProps) {
  const { t, to } = await searchParams;

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
      <ChannelLinkRedeem token={t} provider={asTextConnectProvider(to)} />
    </AuthShell>
  );
}
