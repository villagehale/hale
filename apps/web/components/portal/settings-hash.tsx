'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { resolveSection } from '~/components/hale/settings-sections';

const DEST: Record<string, string> = {
  notif: '/settings/texts',
  plan: '/settings/plan',
  apps: '/settings/connections',
  trust: '/settings/privacy',
  about: '/settings/privacy',
};

/** Old /settings# anchors now live on their own pages. Account stays here. */
export function SettingsHashRedirect() {
  const router = useRouter();
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '').toLowerCase();
    if (!hash) return;
    if (hash === 'family') {
      router.replace('/family');
      return;
    }
    const dest = DEST[resolveSection(hash)];
    if (dest) router.replace(dest);
  }, [router]);
  return null;
}
