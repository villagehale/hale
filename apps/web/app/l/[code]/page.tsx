import type { Metadata } from 'next';
import { cache } from 'react';
import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import { db } from '~/lib/db';
import { providerCredentialsEnabled } from '~/lib/signup/credentials/flag';
import { CREDENTIAL_RETENTION_MS } from '~/lib/signup/credentials/store';
import { LOGIN_PAGE_COPY, loginPurposeLine } from '~/lib/signup/login-link/page-copy';
import { lookupLoginLink } from '~/lib/signup/login-link/store';
import { GoneScreen, ProviderLoginVault } from './vault';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60_000;
const NO_INDEX = { index: false, follow: false };

interface PageProps {
  params: Promise<{ code: string }>;
}

/** One read per request: the link preview's metadata and the page see the same row. */
const openLoginLink = cache(async (code: string) => {
  if (!process.env.DATABASE_URL || !providerCredentialsEnabled()) return null;
  const looked = await lookupLoginLink(db(), code, new Date());
  return looked.ok ? looked : null;
});

/**
 * The card in the thread is this page's preview: the provider in the title, the purpose below.
 * The URL is a bearer code, so no page after this one is told it came from here.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { code } = await params;
  const looked = await openLoginLink(code);
  const title = looked ? LOGIN_PAGE_COPY.heading(looked.providerHost) : 'Hale';
  const description = looked ? loginPurposeLine(looked.purpose) : null;
  return {
    title: { absolute: title },
    description,
    robots: NO_INDEX,
    referrer: 'no-referrer',
    openGraph: { title, description: description ?? undefined, siteName: 'Hale', type: 'website' },
    twitter: { card: 'summary', title, description: description ?? undefined },
  };
}

export default async function ProviderLoginPage({ params }: PageProps) {
  const { code } = await params;
  const looked = await openLoginLink(code);
  if (!looked) return <GoneScreen />;
  return (
    <ProviderLoginVault
      code={code}
      host={looked.providerHost}
      purpose={loginPurposeLine(looked.purpose)}
      retentionDays={Math.round(CREDENTIAL_RETENTION_MS / DAY_MS)}
      smsHref={haleTextsHref()}
    />
  );
}
