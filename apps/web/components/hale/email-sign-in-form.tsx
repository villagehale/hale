'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type SignInState, signInAction } from '~/lib/auth/auth-actions';

/**
 * Email + password sign-in form. The server action verifies the credential and
 * (on success) redirects, so a 'success' state never renders here — only the
 * single generic error does (rule #1: never leak which field was wrong).
 */
export function EmailSignInForm({ redirectTo }: { redirectTo: string }) {
  const action = signInAction.bind(null, redirectTo);
  const [state, formAction] = useActionState<SignInState, FormData>(action, { status: 'idle' });

  return (
    <form action={formAction} className="flex w-full max-w-sm flex-col gap-4">
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
      </div>
      {state.status === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <SubmitButton label="Sign in" />
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending} aria-live="polite">
      {pending ? 'Signing in…' : label}
    </button>
  );
}
