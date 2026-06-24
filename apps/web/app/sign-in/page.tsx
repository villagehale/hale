import Link from 'next/link';
import { signIn } from '~/auth';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { authConfigured } from '~/lib/auth-config';

// Mirrors middleware.ts: the marketing/waitlist site newcomers are sent to.
const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://villagehale.com';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site URL.
  const redirectTo = callbackUrl?.startsWith('/') ? callbackUrl : '/home';

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
      {authConfigured() ? (
        <div className="flex flex-col items-center gap-4">
          <p className="meta max-w-sm text-center">
            Hale is in invite-only beta. Already have access? Continue below.
          </p>
          <form
            action={async () => {
              'use server';
              await signIn('google', { redirectTo });
            }}
          >
            <button type="submit" className="btn-primary">
              Continue with Google
            </button>
          </form>
          <a
            href={MARKETING_URL}
            className="meta underline-offset-4 transition-opacity hover:opacity-70"
          >
            New to Hale? Join the waitlist &rarr;
          </a>
        </div>
      ) : (
        <p className="meta max-w-sm text-center">
          Sign-in isn&rsquo;t available in this preview — Google OAuth isn&rsquo;t configured here.
        </p>
      )}
    </main>
  );
}
