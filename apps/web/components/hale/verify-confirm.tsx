'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { type VerifyState, confirmEmailAction } from '~/lib/auth/auth-actions';

/**
 * The scanner-proof half of /verify. The single-use token is spent ONLY when this
 * button is submitted (a POST). Inbox security scanners and link-prefetchers issue
 * GETs, which render this button but never fire the action — so they can't consume
 * the token before the human clicks. On success we point to sign-in; on failure
 * (unknown/expired/already-used) we offer BOTH "already confirmed? sign in" and a
 * "resend" path, without leaking which case it was.
 */
export function VerifyConfirm({ token }: { token: string }) {
  const action = confirmEmailAction.bind(null, token);
  const [state, formAction] = useActionState<VerifyState, FormData>(action, { status: 'idle' });

  if (state.status === 'ok') {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="meta max-w-sm text-center">You&rsquo;re confirmed. You can sign in now.</p>
        <Link href="/sign-in" className="btn-primary">
          Continue to sign in
        </Link>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-col items-center gap-4">
        <p className="meta max-w-sm text-center">
          We couldn&rsquo;t confirm this link — it may have expired or already been used.
        </p>
        <div className="flex flex-col items-center gap-2">
          <Link href="/sign-in" className="btn-primary">
            Already confirmed? Sign in
          </Link>
          <Link href="/sign-up" className="btn-ghost">
            Need a fresh link? Resend
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col items-center gap-4">
      <p className="meta max-w-sm text-center">
        One more step — confirm your email to finish setting up your account.
      </p>
      <ConfirmButton />
    </form>
  );
}

function ConfirmButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending} aria-live="polite">
      {pending ? 'Confirming…' : 'Confirm my email'}
    </button>
  );
}
