'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type SignInState, signInAction } from '~/lib/auth/auth-actions';
import { ResendVerificationButton } from '~/components/hale/resend-verification-button';

/**
 * Email + password sign-in form. The server action verifies the credential and
 * (on success) redirects, so a 'success' state never renders here — only the
 * single generic error does (rule #1: never leak which field was wrong).
 */
export function EmailSignInForm({
  redirectTo,
  secondary = false,
}: {
  redirectTo: string;
  // When Google sits above as the primary action, the email submit drops to
  // secondary styling so the page has a single primary. Credentials-only, it
  // stays primary.
  secondary?: boolean;
}) {
  const action = signInAction.bind(null, redirectTo);
  const [state, formAction] = useActionState<SignInState, FormData>(action, { status: 'idle' });

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="field-group">
        <label htmlFor="signin-email" className="field-label">
          Email
        </label>
        <input
          id="signin-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="field"
        />
      </div>
      <div className="field-group">
        <label htmlFor="signin-password" className="field-label">
          Password
        </label>
        <input
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="field"
        />
        <Link href="/forgot-password" className="btn-ghost self-start">
          Forgot your password?
        </Link>
      </div>
      {state.status === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === 'unverified' ? (
        <output className="flex flex-col gap-2">
          <p className="meta">
            Check your inbox to confirm your email first — that unlocks your account.
          </p>
          <ResendVerificationButton email={state.email} label="Resend confirmation link" />
        </output>
      ) : null}
      <SubmitButton label="Sign in" secondary={secondary} />
    </form>
  );
}

function SubmitButton({ label, secondary }: { label: string; secondary: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={secondary ? 'btn-secondary justify-center' : 'btn-primary'}
      disabled={pending}
      aria-live="polite"
    >
      {pending ? 'Signing in…' : label}
    </button>
  );
}
