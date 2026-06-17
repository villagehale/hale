import Link from 'next/link';
import { SignIn } from '@clerk/nextjs';
import { clerkConfigured } from '~/lib/auth-config';
import { meadowAppearance } from '~/lib/clerk-appearance';

export default function SignInPage() {
  return (
    <main className="min-h-screen bg-linen flex flex-col items-center justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-display text-2xl">
        Hale
      </Link>
      {clerkConfigured() ? (
        <SignIn appearance={meadowAppearance} />
      ) : (
        <p className="meta max-w-sm text-center">
          Sign-in isn&rsquo;t available in this preview — Clerk isn&rsquo;t configured here.
        </p>
      )}
    </main>
  );
}
