import type { ReactNode } from 'react';
import { buildRootHeroes } from '~/components/hale/hero-map';
import { PortalShell } from '~/components/portal/shell';
import { DEMO_BASE, DEMO_SIGN_IN } from '~/lib/portal/demo-fixture';

export default function DemoPortalLayout({ children }: { children: ReactNode }) {
  const roots = buildRootHeroes({ greeting: 'Hi, Pat' });
  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <PortalShell canSignOut={false} signOutTo={DEMO_SIGN_IN} basePath={DEMO_BASE} roots={roots}>
        {children}
      </PortalShell>
    </>
  );
}
