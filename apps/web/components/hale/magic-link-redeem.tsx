'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef } from 'react';
import stage from '~/components/hale/connect/connect.module.css';
import door from '~/components/portal/signin.module.css';
import { type MagicLinkRedeemState, redeemMagicLinkAction } from '~/lib/auth/magic-link-actions';

/**
 * Redeems a magic link on load. The token comes from the URL and is bound into the
 * action (never rendered in an input). Submission is a client-side POST fired once
 * on mount — so an inbox link-scanner (which issues a GET and runs no JS) can't
 * spend the single-use token before the human clicks. On success the action signs
 * the user in and redirects, so only the invalid/expired error renders here.
 */
export function MagicLinkRedeem({ token, redirectTo }: { token: string; redirectTo: string }) {
  const action = redeemMagicLinkAction.bind(null, token, redirectTo);
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
      <div className={door.stack}>
        <p className="field-error" role="alert">
          {state.message}
        </p>
        <Link href="/sign-in" className={`${stage.btn} ${door.full}`}>
          Request a new link
        </Link>
      </div>
    );
  }

  return (
    <form ref={formRef} action={formAction}>
      <p className={stage.lede} aria-live="polite">
        Signing you in&hellip;
      </p>
    </form>
  );
}
