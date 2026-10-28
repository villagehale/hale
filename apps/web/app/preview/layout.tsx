import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { portalDemoEnabled } from '~/lib/flags/portal-demo';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (!portalDemoEnabled()) {
    return {
      robots: { index: false, follow: false },
      title: { absolute: 'Page not found · Hale' },
    };
  }
  return {
    robots: { index: false, follow: false },
    title: 'Group RSVP preview · Hale',
  };
}

export default function PreviewLayout({ children }: { children: ReactNode }) {
  if (!portalDemoEnabled()) notFound();
  return children;
}
