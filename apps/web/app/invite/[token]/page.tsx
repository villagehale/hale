import Link from 'next/link';
import { auth } from '~/auth';
import { authConfigured } from '~/lib/auth-config';
import { InviteAcceptButton } from '~/components/hale/invite-accept-button';
import { loadInvite } from '~/lib/invites/queries';

interface PageProps {
  params: Promise<{ token: string }>;
}

/**
 * Public invite landing — lives OUTSIDE the (authed) group so a logged-out
 * invitee can read it. Surfaces only the family name and the inviter's first
 * name (rule #1: never the inviter's email). A signed-out visitor signs in and
 * returns here; a signed-in visitor accepts. Unknown / expired / already-claimed
 * invites render a single friendly invalid state — never a crash.
 */
export default async function InvitePage({ params }: PageProps) {
  const { token } = await params;
  const invite = await loadInvite(token);
  const session = authConfigured() ? await auth() : null;

  const invalidReason = !invite
    ? 'this invite link is no longer valid.'
    : invite.expired
      ? 'this invite has expired. ask for a fresh link.'
      : invite.alreadyAccepted
        ? 'this invite has already been used.'
        : null;

  return (
    <main className="min-h-screen bg-linen flex flex-col items-center justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-display text-2xl">
        Hale
      </Link>

      {invalidReason || !invite ? (
        <div className="panel max-w-md text-center space-y-4">
          <span className="eyebrow">invite</span>
          <p className="text-lg text-slate-green leading-relaxed">{invalidReason}</p>
          <Link href="/" className="btn-ghost">
            go home →
          </Link>
        </div>
      ) : (
        <div className="panel max-w-md text-center space-y-6">
          <span className="eyebrow">you&rsquo;ve been invited</span>
          <p className="font-display text-2xl leading-snug">
            join {invite.familyDisplayName}&rsquo;s village
          </p>
          {invite.inviterFirstName ? (
            <p className="meta">{invite.inviterFirstName} invited you to share the load.</p>
          ) : null}

          {authConfigured() ? (
            session?.user?.id ? (
              <InviteAcceptButton token={invite.token} />
            ) : (
              <Link
                href={`/sign-in?callbackUrl=/invite/${invite.token}`}
                className="btn-primary"
              >
                sign in to accept
              </Link>
            )
          ) : (
            <p className="meta">
              accepting an invite isn&rsquo;t available in this preview — Google OAuth
              isn&rsquo;t configured here.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
