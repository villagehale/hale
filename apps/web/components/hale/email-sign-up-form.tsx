'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { type SignUpState, signUpAction } from '~/lib/auth/auth-actions';
import { MIN_PASSWORD_LENGTH } from '~/lib/auth/constants';
import { ResendVerificationButton } from '~/components/hale/resend-verification-button';

/**
 * Email + password sign-up form. On success the action returns 'check_email' (the
 * verification link was sent) — and a duplicate email returns the SAME state, so
 * the form never reveals whether an address is already registered (rule #1).
 */
export function EmailSignUpForm() {
  const [state, formAction] = useActionState<SignUpState, FormData>(signUpAction, {
    status: 'idle',
  });
  // Retain the submitted address so the check-email confirmation can echo it and
  // the resend affordance can act without re-typing. Client-only, never logged.
  const [email, setEmail] = useState('');
  const capture = useAnalytics();

  if (state.status === 'check_email') {
    return (
      <div className="flex max-w-sm flex-col gap-3 text-center">
        <output className="meta block">
          We sent a link to <strong>{email}</strong>. Click it to finish setting up your account.
        </output>
        <ResendVerificationButton email={email} label="Didn't get it? Resend the link" />
        <button type="button" onClick={() => window.location.reload()} className="btn-ghost self-center">
          Wrong address? Start over
        </button>
      </div>
    );
  }

  // Coarse funnel signal on submit — method only, never the email entered (rule #1).
  function submit(formData: FormData) {
    setEmail(String(formData.get('email') ?? ''));
    capture('signup_completed', { method: 'email' });
    formAction(formData);
  }

  return (
    <form action={submit} className="flex w-full max-w-sm flex-col gap-4">
      <div className="field-group">
        <label htmlFor="signup-email" className="field-label">
          Email
        </label>
        <input
          id="signup-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          className="field"
        />
      </div>
      <div className="field-group">
        <label htmlFor="signup-password" className="field-label">
          Password
        </label>
        <input
          id="signup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          className="field"
        />
        <p className="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
      </div>
      {state.status === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending} aria-live="polite">
      {pending ? 'Creating account…' : 'Create account'}
    </button>
  );
}
