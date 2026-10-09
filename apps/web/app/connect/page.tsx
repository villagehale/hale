import type { Metadata } from 'next';
import { ChannelLinkRedeem } from '~/components/hale/channel-link-redeem';
import { StatusCard } from '~/components/hale/connect/connect-cards';
import { ConnectPreview } from '~/components/hale/connect/connect-preview';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { authConfigured } from '~/lib/auth-config';
import {
  LINK_INCOMPLETE_TAB,
  MISSING_DESCRIPTION,
  connectPageMeta,
  connectPreviewEnabled,
  isConnectPreviewState,
  missingLink,
  withHaleSuffix,
} from '~/lib/channel/connect/connect-page-copy';
import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import { asTextConnectProvider } from '~/lib/channel/connect/text-connect';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ t?: string; to?: string; preview?: string }>;
}

/**
 * The link unfurls as its own card. Title is the ask, description is the lede.
 * The token stays out of every tag a preview crawler stores.
 */
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { t, to } = await searchParams;
  const provider = asTextConnectProvider(to);
  const card =
    !authConfigured() || !t
      ? { tabTitle: LINK_INCOMPLETE_TAB, description: MISSING_DESCRIPTION }
      : connectPageMeta(provider);
  // The document title is bare so the root template can suffix it once.
  // openGraph and twitter titles are not templated, so they take the full string.
  const socialTitle = withHaleSuffix(card.tabTitle);
  return {
    title: card.tabTitle,
    description: card.description,
    robots: { index: false, follow: false },
    openGraph: {
      title: socialTitle,
      description: card.description,
      siteName: 'Hale',
      locale: 'en_CA',
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title: socialTitle,
      description: card.description,
    },
  };
}

/**
 * Redeem landing for the texted connect link (/connect?t=…&to=gcal). Rendering
 * this page never consumes the token. The Redeem tap signs them in and leaves
 * the token usable until Google consent succeeds.
 *
 * `to` is read through the allowlist. An unrecognised value is not an error —
 * the next step is Settings, so the button is a plain Continue, not Google's.
 *
 * `preview` forces a design state only when NODE_ENV is development. Vercel
 * preview and `next start` are production and ignore it.
 */
export default async function ConnectPage({ searchParams }: PageProps) {
  const { t, to, preview } = await searchParams;

  if (connectPreviewEnabled() && isConnectPreviewState(preview)) {
    return <ConnectPreview state={preview} />;
  }

  const smsHref = haleTextsHref();

  if (!authConfigured() || !t) {
    return (
      <ConnectStage>
        <StatusCard copy={missingLink()} smsHref={smsHref} />
      </ConnectStage>
    );
  }

  return (
    <ConnectStage>
      <ChannelLinkRedeem token={t} provider={asTextConnectProvider(to)} smsHref={smsHref} />
    </ConnectStage>
  );
}
