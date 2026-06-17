import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { Sidebar } from '~/components/hale/sidebar';
import { TopHeader } from '~/components/hale/top-header';
import { FamilyHeader } from '~/components/hale/family-header';
import { clerkConfigured } from '~/lib/auth-config';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = clerkConfigured();
  if (authEnabled) {
    const { userId } = await auth();
    if (!userId) redirect('/onboarding');
  }

  return (
    <div className="editorial-layout">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Sidebar authControls={authEnabled} />
      <div>
        <TopHeader />
        <main id="main-content" className="main-stage">
          {!authEnabled && (
            <output className="dev-preview-banner">
              Auth disabled — development preview. This route group is unprotected
              because Clerk is not configured.
            </output>
          )}
          <FamilyHeader />
          {children}
        </main>
      </div>
    </div>
  );
}
