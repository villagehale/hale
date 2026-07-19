import { AuthShell } from '~/components/hale/auth-shell';

export const dynamic = 'force-dynamic';

// The native app's URL scheme — source of truth is apps/mobile/app.json
// (expo.scheme). The link hands the token to the app, which POSTs it to
// /api/mobile/auth/magic-link/verify for a Bearer session.
const HALE_APP_SCHEME = 'hale';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Deep-link hand-off for a mobile magic link. The email lands here (a web page,
 * always openable) with ?token=…; the button opens the native app via its scheme,
 * carrying the token. Deliberately minimal — the real redemption happens in the app
 * against /api/mobile/auth/magic-link/verify, not here.
 */
export default async function MobileMagicPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <AuthShell heading="Open Hale">
        <p className="meta">This sign-in link is missing or incomplete. Request a fresh one.</p>
      </AuthShell>
    );
  }

  const appUrl = `${HALE_APP_SCHEME}://magic-link?token=${encodeURIComponent(token)}`;

  return (
    <AuthShell heading="Open Hale">
      <a href={appUrl} className="btn-primary self-start">
        Open the Hale app
      </a>
      <p className="meta">
        Continue on this device isn&rsquo;t available &mdash; open the link on your phone with Hale
        installed.
      </p>
    </AuthShell>
  );
}
