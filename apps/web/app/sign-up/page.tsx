import Link from 'next/link';
import { EmailSignUpForm } from '~/components/hale/email-sign-up-form';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { credentialsConfigured } from '~/lib/auth-config';

export default function SignUpPage() {
  const credentials = credentialsConfigured();

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
      {credentials ? (
        <div className="flex flex-col items-center gap-4">
          <p className="meta max-w-sm text-center">Create your Hale account.</p>
          <EmailSignUpForm />
          <Link
            href="/sign-in"
            className="meta underline-offset-4 transition-opacity hover:opacity-70"
          >
            Already have an account? Sign in &rarr;
          </Link>
        </div>
      ) : (
        <p className="meta max-w-sm text-center">
          Sign-up isn&rsquo;t available in this preview — no auth provider is configured here.
        </p>
      )}
    </main>
  );
}
