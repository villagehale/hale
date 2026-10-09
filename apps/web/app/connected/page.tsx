import type { Metadata } from 'next';
import { StatusCard } from '~/components/hale/connect/connect-cards';
import { ConnectPreview } from '~/components/hale/connect/connect-preview';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import {
  connectPreviewEnabled,
  connectedStatus,
  isConnectPreviewState,
} from '~/lib/channel/connect/connect-page-copy';
import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{
    provider?: string;
    status?: string;
    who?: string;
    lang?: string;
    fresh?: string;
    preview?: string;
  }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { provider, status, lang, fresh } = await searchParams;
  const notice = connectedStatus(status, provider, {
    language: lang === 'fr' ? 'fr' : 'en',
    freshLink: fresh === 'sent',
  });
  return {
    title: notice.aria,
    robots: { index: false, follow: false },
  };
}

/**
 * GET /connected — the end of a connect the parent started in a text thread.
 *
 * Closeable. No auth, no DB read, no way onward into Settings: the callback
 * already stored the connection, and the receipt is a text on the same phone.
 * The query carries a provider slug and a status word. `who` is rendered as
 * text and never written into metadata.
 */
export default async function ConnectedPage({ searchParams }: PageProps) {
  const { provider, status, who, lang, fresh, preview } = await searchParams;

  if (connectPreviewEnabled() && isConnectPreviewState(preview)) {
    return <ConnectPreview state={preview} />;
  }

  const notice = connectedStatus(status, provider, {
    name: who,
    language: lang === 'fr' ? 'fr' : 'en',
    freshLink: fresh === 'sent',
  });

  return (
    <ConnectStage>
      <StatusCard copy={notice} smsHref={haleTextsHref()} />
    </ConnectStage>
  );
}
