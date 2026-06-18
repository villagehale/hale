import Link from 'next/link';
import { signIn } from '~/auth';
import { authConfigured } from '~/lib/auth-config';

interface PageProps {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const { callbackUrl } = await searchParams;
  // Only honor app-internal redirect targets — never an off-site URL.
  const redirectTo = callbackUrl?.startsWith('/') ? callbackUrl : '/digest';

  return (
    <main className="min-h-screen bg-linen flex flex-col items-center justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-display text-2xl">
        Hale
      </Link>
      {authConfigured() ? (
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
      ) : (
        <p className="meta max-w-sm text-center">
          Sign-in isn&rsquo;t available in this preview — Google OAuth isn&rsquo;t configured here.
        </p>
      )}
    </main>
  );
}
