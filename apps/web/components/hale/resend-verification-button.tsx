'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type ResendState, resendVerificationAction } from '~/lib/auth/auth-actions';

/**
 * Re-send the verification email for a known address. Submits the email in a hidden
 * field so the action needs no re-typing; the response is the SAME "sent" state
 * whether or not the address has an unconfirmed account (anti-enumeration lives in
 * the action). Rendered wherever we already know the address — the sign-in
 * "unverified" state and the sign-up "check your email" confirmation.
 */
export function ResendVerificationButton({ email, label }: { email: string; label: string }) {
  const [state, formAction] = useActionState<ResendState, FormData>(resendVerificationAction, {
    status: 'idle',
  });

  if (state.status === 'sent') {
    return (
      <output className="meta block">
        Sent — check your inbox for a fresh confirmation link.
      </output>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="email" value={email} />
      {state.status === 'error' ? (
        <p className="field-error" role="alert">
          {state.message}
        </p>
      ) : null}
      <Submit label={label} />
    </form>
  );
}

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-ghost self-start" disabled={pending} aria-live="polite">
      {pending ? 'Sending…' : label}
    </button>
  );
}
