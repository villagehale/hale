import Link from 'next/link';
import { VerifyConfirm } from '~/components/hale/verify-confirm';
import { authConfigured } from '~/lib/auth-config';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

// The token must never be redeemed at render time (a GET) — only when the user
// submits the confirm button — so this page can't be statically cached with a
// stale outcome, and a prefetch of the render can't spend the token.
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Email-verification landing for /verify?token=…. Scanner-proof by construction:
 * the GET only RENDERS a "Confirm my email" button; the single-use token is spent
 * solely by the POST that button issues (see VerifyConfirm / confirmEmailAction).
 * Inbox link-scanners and prefetchers that GET the page can't consume the token.
 */
export default async function VerifyPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const ready = authConfigured() && Boolean(token);

  return (
    <main className="min-h-[100dvh] bg-linen flex flex-col items-center justify-center gap-8 px-6 py-16">
      <header className="absolute top-0 left-0 right-0 shell flex items-center justify-between pt-8">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold">Hale</span>
        </Link>
        <ThemeToggle />
      </header>
      <Link href="/" className="flex items-center gap-3">
        <LogoMark size={40} />
        <span className="font-display text-3xl font-semibold">Hale</span>
      </Link>
      {ready && token ? (
        <VerifyConfirm token={token} />
      ) : (
        <div className="flex flex-col items-center gap-4">
          <p className="meta max-w-sm text-center">
            This confirmation link is missing or incomplete. Sign up again to get a fresh link.
          </p>
          <Link href="/sign-up" className="btn-primary">
            Back to sign up
          </Link>
        </div>
      )}
    </main>
  );
}
