import type { Metadata } from 'next';
import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import { db } from '~/lib/db';
import { providerCredentialsEnabled } from '~/lib/signup/credentials/flag';
import { lookupLoginLink } from '~/lib/signup/login-link/store';
import { GoneScreen, ProviderLoginVault } from './vault';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Hale',
  robots: { index: false, follow: false },
};

interface PageProps {
  params: Promise<{ code: string }>;
}

export default async function ProviderLoginPage({ params }: PageProps) {
  const { code } = await params;
  if (!process.env.DATABASE_URL || !providerCredentialsEnabled()) return <GoneScreen />;
  const looked = await lookupLoginLink(db(), code, new Date());
  if (!looked.ok) return <GoneScreen />;
  const host = looked.providerHost;
  return (
    <ProviderLoginVault
      code={code}
      host={host}
      providerUrl={`https://${host}`}
      smsHref={haleTextsHref()}
    />
  );
}
