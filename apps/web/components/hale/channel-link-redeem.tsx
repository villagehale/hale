'use client';

import { useActionState } from 'react';
import { FallbackCard, LandingCard, StatusCard } from '~/components/hale/connect/connect-cards';
import {
  type ChannelLinkRedeemState,
  redeemChannelLinkAction,
} from '~/lib/auth/channel-link-actions';
import { landingCopy, redeemErrorStatus } from '~/lib/channel/connect/connect-page-copy';
import { type TextLinkTarget, asTextConnectProvider } from '~/lib/channel/connect/text-connect';

/**
 * Redeems a texted sign-in link on a TAP, never on load. Carrier scanners follow
 * the URL and run no JS. The token is bound into the action, never rendered.
 * A named connector goes to Google; anything else continues to the page the link
 * names (or the family page), and that button is not the Google mark.
 */
export function ChannelLinkRedeem({
  token,
  to,
  smsHref,
}: {
  token: string;
  to: TextLinkTarget | null;
  smsHref: string | null;
}) {
  const provider = asTextConnectProvider(to);
  // VIL-721. `to` was narrowed on the server, so `google` here means the one-link flow
  // is on: the landing names both Gmail and the calendar.
  const landing = to === 'google' ? to : provider;
  const action = redeemChannelLinkAction.bind(null, token, to);
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

  if (!landing) {
    return <FallbackCard formAction={formAction} pending={pending} />;
  }

  return <LandingCard copy={landingCopy(landing)} formAction={formAction} pending={pending} />;
}
