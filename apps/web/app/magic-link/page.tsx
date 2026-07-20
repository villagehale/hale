import Link from 'next/link';
import { AuthShell } from '~/components/hale/auth-shell';
import { MagicLinkRedeem } from '~/components/hale/magic-link-redeem';
import { credentialsConfigured } from '~/lib/auth-config';

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Redeem landing for /magic-link?token=…. The token is validated (single-use,
 * expiring, hashed at rest) only when the client component submits it, in the
 * server action — this page render never consumes it. A missing token shows a calm
 * path back to request a fresh one.
 */
export default async function MagicLinkPage({ searchParams }: PageProps) {
  const { token } = await searchParams;

  if (!credentialsConfigured()) {
    return (
      <AuthShell heading="Sign in to Hale">
        <p className="meta">Magic-link sign-in isn&rsquo;t available in this preview.</p>
      </AuthShell>
    );
  }

  if (!token) {
    return (
      <AuthShell heading="Sign in to Hale">
        <p className="meta">
          This sign-in link is missing or incomplete. Request a fresh one and try again.
        </p>
        <Link href="/sign-in" className="btn-primary self-start">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell heading="Sign in to Hale">
      <MagicLinkRedeem token={token} />
    </AuthShell>
  );
}
