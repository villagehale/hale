import Link from 'next/link';
import { SignUp } from '@clerk/nextjs';
import { clerkConfigured } from '~/lib/auth-config';
import { meadowAppearance } from '~/lib/clerk-appearance';

export default function SignUpPage() {
  return (
    <main className="min-h-screen bg-linen flex flex-col items-center justify-center gap-8 px-6 py-16">
      <Link href="/" className="font-display text-2xl">
        Hale
      </Link>
      {clerkConfigured() ? (
        <SignUp appearance={meadowAppearance} />
      ) : (
        <p className="meta max-w-sm text-center">
          Sign-up isn&rsquo;t available in this preview — Clerk isn&rsquo;t configured here.
        </p>
      )}
    </main>
  );
}
