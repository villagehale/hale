import type { Database } from '@hale/db';
import Link from 'next/link';
import { verifyEmailToken } from '~/lib/auth/credentials';
import { authConfigured } from '~/lib/auth-config';
import { db } from '~/lib/db';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Email-verification landing for /verify?token=…. Redeems the single-use token
 * (lib/auth/credentials.ts) and reports success or failure. On success the user is
 * pointed at sign-in; a missing/expired/used token shows a calm retry path rather
 * than leaking which case it was.
 */
export default async function VerifyPage({ searchParams }: PageProps) {
  const { token } = await searchParams;
  const ok = authConfigured() && token ? Boolean(await verifyEmailToken(token, db() as Database)) : false;

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
      {ok ? (
        <div className="flex flex-col items-center gap-4">
          <p className="meta max-w-sm text-center">
            Your email is confirmed. You can sign in now.
          </p>
          <Link href="/sign-in" className="btn-primary">
            Continue to sign in
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <p className="meta max-w-sm text-center">
            This confirmation link is invalid or has expired. Try signing up again to get a fresh
            link.
          </p>
          <Link href="/sign-up" className="btn-primary">
            Back to sign up
          </Link>
        </div>
      )}
    </main>
  );
}
