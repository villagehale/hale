'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import stage from '~/components/hale/connect/connect.module.css';
import door from '~/components/portal/signin.module.css';
import { type ResetPasswordState, resetPasswordAction } from '~/lib/auth/auth-actions';
import { MIN_PASSWORD_LENGTH } from '~/lib/auth/constants';

/**
 * Set a new password from a reset link. The token comes from the URL and is bound
 * into the action (never rendered in an input the user could tamper with). On
 * success the action signs the user in and redirects, so no success state renders
 * here — only the generic invalid-token / weak-password error does.
 */
export function ResetPasswordForm({
  token,
  action,
  initialState = { status: 'idle' },
}: {
  token: string;
  action?: (prev: ResetPasswordState, formData: FormData) => Promise<ResetPasswordState>;
  initialState?: ResetPasswordState;
}) {
  const bound = action ?? resetPasswordAction.bind(null, token);
  const [state, formAction] = useActionState<ResetPasswordState, FormData>(bound, initialState);

  return (
    <form action={formAction}>
      <div className={door.field}>
        <label htmlFor="reset-password">New password</label>
        <input
          id="reset-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          className={door.input}
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
    <button
      type="submit"
      className={`${stage.btn} ${door.full}`}
      disabled={pending}
      aria-live="polite"
    >
      {pending ? 'Saving…' : 'Set new password'}
    </button>
  );
}
