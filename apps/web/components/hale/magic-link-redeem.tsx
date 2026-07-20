'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import { type MagicLinkRedeemState, redeemMagicLinkAction } from '~/lib/auth/magic-link-actions';

/**
 * Redeems a magic link on load. The token comes from the URL and is bound into the
 * action (never rendered in an input). Submission is a client-side POST fired once
 * on mount — so an inbox link-scanner (which issues a GET and runs no JS) can't
 * spend the single-use token before the human clicks. On success the action signs
 * the user in and redirects, so only the invalid/expired error renders here.
 */
export function MagicLinkRedeem({ token }: { token: string }) {
  const action = redeemMagicLinkAction.bind(null, token);
  const [state, formAction] = useActionState<MagicLinkRedeemState, FormData>(action, {
    status: 'idle',
  });
  const formRef = useRef<HTMLFormElement>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (!submitted.current) {
      submitted.current = true;
      formRef.current?.requestSubmit();
    }
  }, []);

  if (state.status === 'error') {
    return (
      <div className="flex w-full flex-col gap-4">
        <p className="field-error" role="alert">
          {state.message}
        </p>
        <Link href="/sign-in" className="btn-primary self-start">
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form ref={formRef} action={formAction} className="flex w-full flex-col gap-4">
      <p className="meta" aria-live="polite">
        Signing you in&hellip;
      </p>
    </form>
  );
}
