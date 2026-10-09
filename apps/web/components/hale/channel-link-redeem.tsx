'use client';

import { useActionState } from 'react';
import { FallbackCard, LandingCard, StatusCard } from '~/components/hale/connect/connect-cards';
import {
  type ChannelLinkRedeemState,
  redeemChannelLinkAction,
} from '~/lib/auth/channel-link-actions';
import { landingCopy, redeemErrorStatus } from '~/lib/channel/connect/connect-page-copy';
import type { TextConnectProvider } from '~/lib/channel/connect/text-connect';

/**
 * Redeems a texted sign-in link on a TAP, never on load. Carrier scanners follow
 * the URL and run no JS. The token is bound into the action, never rendered.
 * A named connector goes to Google; anything else continues to Settings, and
 * that button is not the Google mark.
 */
export function ChannelLinkRedeem({
  token,
  provider,
  smsHref,
}: {
  token: string;
  provider: TextConnectProvider | null;
  smsHref: string | null;
}) {
  const action = redeemChannelLinkAction.bind(null, token, provider);
  const [state, formAction, pending] = useActionState<ChannelLinkRedeemState, FormData>(action, {
    status: 'idle',
  });

  if (state.status === 'error') {
    const copy = redeemErrorStatus(state.message, provider);
    return (
      <StatusCard
        copy={copy}
        smsHref={smsHref}
        formAction={copy.retry ? formAction : undefined}
        pending={pending}
      />
    );
  }

  if (!provider) {
    return <FallbackCard formAction={formAction} pending={pending} />;
  }

  return <LandingCard copy={landingCopy(provider)} formAction={formAction} pending={pending} />;
}
