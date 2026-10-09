import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { portalDemoEnabled } from '~/lib/flags/portal-demo';
import { DEMO_TITLE } from '~/lib/portal/document-title';

// VERCEL_ENV is a runtime fact. A production build must not bake the demo in.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
  title: DEMO_TITLE,
};

/**
 * Seeded design-QA tree. Production (`VERCEL_ENV=production`) 404s the whole
 * tree. Preview and local `next start` serve it with no session and no secrets.
 */
export default function DemoLayout({ children }: { children: ReactNode }) {
  if (!portalDemoEnabled()) notFound();
  return children;
}
