'use client';

import { useActionState } from 'react';
import { type ChannelLinkRedeemState, redeemChannelLinkAction } from '~/lib/auth/channel-link-actions';

/**
 * Redeems a texted sign-in link on a TAP, never on load — the one deliberate
 * difference from MagicLinkRedeem's auto-submit. An SMS link gets prefetched by
 * carrier scanners and Apple's link previews, which run no JS but do follow
 * redirects; a human tap is the only thing that may spend the single-use token, and
 * the button is also the interstitial that keeps a Google consent screen from
 * erupting straight out of a text message. The token is bound into the action, never
 * rendered in an input.
 */
export function ChannelLinkRedeem({ token }: { token: string }) {
  const action = redeemChannelLinkAction.bind(null, token);
  const [state, formAction, pending] = useActionState<ChannelLinkRedeemState, FormData>(action, {
    status: 'idle',
  });

  if (state.status === 'error') {
    return (
      <p className="field-error" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <form action={formAction} className="flex w-full flex-col gap-4">
      <p className="meta">One tap signs you in and opens your connected apps.</p>
      <button type="submit" className="btn-primary self-start" disabled={pending}>
        {pending ? 'Signing you in…' : 'Continue'}
      </button>
    </form>
  );
}
