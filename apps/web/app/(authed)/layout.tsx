import { redirect } from 'next/navigation';
import { auth } from '~/auth';
import { Sidebar } from '~/components/hale/sidebar';
import { TopHeader } from '~/components/hale/top-header';
import { FamilyHeader } from '~/components/hale/family-header';
import { authConfigured } from '~/lib/auth-config';

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = authConfigured();
  const session = authEnabled ? await auth() : null;
  if (authEnabled && !session?.user?.id) {
    redirect('/sign-in');
  }

  return (
    <div className="editorial-layout">
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>
      <Sidebar authControls={authEnabled} signedIn={Boolean(session?.user?.id)} />
      <div>
        <TopHeader />
        <main id="main-content" className="main-stage">
          {!authEnabled && (
            <output className="dev-preview-banner">
              Auth disabled — development preview. This route group is unprotected
              because Google OAuth is not configured.
            </output>
          )}
          <FamilyHeader />
          {children}
        </main>
      </div>
    </div>
  );
}
