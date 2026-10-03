import type { Metadata } from 'next';
import { AuthShell } from '~/components/hale/auth-shell';
import { ChannelLinkRedeem } from '~/components/hale/channel-link-redeem';
import { authConfigured } from '~/lib/auth-config';
import {
  asTextConnectProvider,
  connectorLinkCard,
  googleUnverifiedAppLine,
} from '~/lib/channel/connect/text-connect';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ t?: string; to?: string }>;
}

/**
 * The link unfurls as its own card. Title is the ask, description is the one
 * trust line. The token stays out of every tag a preview crawler stores.
 */
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { to } = await searchParams;
  const card = connectorLinkCard(asTextConnectProvider(to));
  return {
    title: card.title,
    description: card.description,
    robots: { index: false, follow: false },
    openGraph: {
      title: card.title,
      description: card.description,
      siteName: 'Hale',
      locale: 'en_CA',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: card.title,
      description: card.description,
    },
  };
}

/**
 * Redeem landing for the texted connect link (/connect?t=…&to=gcal). Rendering this
 * page never consumes the token, so a carrier link-scanner's GET costs the parent
 * nothing. The Redeem tap signs them in and leaves the token usable until Google
 * consent succeeds. A missing token cannot name a parent, so nothing is minted.
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
        <p className="meta">This link is missing or incomplete.</p>
      </AuthShell>
    );
  }

  const provider = asTextConnectProvider(to);
  const card = connectorLinkCard(provider);

  return (
    <AuthShell heading={card.title}>
      <p className="meta">{card.description}</p>
      {provider ? <p className="meta">{googleUnverifiedAppLine('en')}</p> : null}
      <ChannelLinkRedeem token={t} provider={provider} />
    </AuthShell>
  );
}
