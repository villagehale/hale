'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type ResetRequestState, requestPasswordResetAction } from '~/lib/auth/auth-actions';

/**
 * Request a password-reset link. Whatever the outcome, the confirmation is the SAME
 * "if that email has an account…" message — the form never reveals whether the
 * address is registered (anti-enumeration lives in the action, rule #1).
 */
export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<ResetRequestState, FormData>(
    requestPasswordResetAction,
    { status: 'idle' },
  );

  if (state.status === 'sent') {
    return (
      <output className="meta block max-w-sm">
        If that email has an account, we&rsquo;ve sent a link to reset your password. It expires in
        an hour.
      </output>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="field-group">
        <label htmlFor="forgot-email" className="field-label">
          Email
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          spellCheck={false}
          autoCapitalize="none"
          required
          className="field"
        />
        <p className="field-hint">We&rsquo;ll email a link to set a new password.</p>
      </div>
      {state.status === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending} aria-live="polite">
      {pending ? 'Sending…' : 'Send reset link'}
    </button>
  );
}
