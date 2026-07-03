'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type ResetPasswordState, resetPasswordAction } from '~/lib/auth/auth-actions';
import { MIN_PASSWORD_LENGTH } from '~/lib/auth/constants';

/**
 * Set a new password from a reset link. The token comes from the URL and is bound
 * into the action (never rendered in an input the user could tamper with). On
 * success the action signs the user in and redirects, so no success state renders
 * here — only the generic invalid-token / weak-password error does.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const action = resetPasswordAction.bind(null, token);
  const [state, formAction] = useActionState<ResetPasswordState, FormData>(action, {
    status: 'idle',
  });

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <div className="field-group">
        <label htmlFor="reset-password" className="field-label">
          New password
        </label>
        <input
          id="reset-password"
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
      <Submit />
    </form>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending} aria-live="polite">
      {pending ? 'Saving…' : 'Set new password'}
    </button>
  );
}
