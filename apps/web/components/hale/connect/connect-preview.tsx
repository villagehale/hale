import {
  type ConnectPreviewState,
  REDEEM_TRY_AGAIN,
  connectedStatus,
  landingCopy,
  missingLink,
  redeemErrorStatus,
} from '~/lib/channel/connect/connect-page-copy';
import { DisconnectPreview, LandingCard, StatusCard } from './connect-cards';
import { ConnectStage } from './connect-stage';

/** A number only this dev preview uses, so the texts button is on the screenshot. */
const PREVIEW_SMS = 'sms:+15555550100';

/**
 * Force one design state. The page calls this only when connectPreviewEnabled()
 * is true (NODE_ENV === 'development').
 */
export function ConnectPreview({ state }: { state: ConnectPreviewState }) {
  const sms = PREVIEW_SMS;
  const body = (() => {
    switch (state) {
      case 'gmail-landing':
        return <LandingCard copy={landingCopy('gmail')} formAction="#preview" />;
      case 'gcal-landing':
        return <LandingCard copy={landingCopy('gcal')} formAction="#preview" />;
      case 'gmail-handoff':
        return <LandingCard copy={landingCopy('gmail')} formAction="#preview" pending />;
      case 'gmail-success':
        return <StatusCard copy={connectedStatus('ok', 'gmail')} smsHref={null} />;
      case 'gcal-success':
        return <StatusCard copy={connectedStatus('ok', 'gcal')} smsHref={null} />;
      case 'denied':
        return (
          <StatusCard
            copy={connectedStatus('denied', 'gmail', { freshLink: true })}
            smsHref={sms}
          />
        );
      case 'partial-scope':
        return (
          <StatusCard
            copy={connectedStatus('partial', 'gmail', { freshLink: true })}
            smsHref={sms}
          />
        );
      case 'expired':
        return (
          <StatusCard
            copy={connectedStatus('invalid', 'gmail', { freshLink: true })}
            smsHref={sms}
          />
        );
      case 'error':
        return (
          <StatusCard copy={connectedStatus('error', 'gmail', { freshLink: true })} smsHref={sms} />
        );
      case 'retry':
        return (
          <StatusCard
            copy={redeemErrorStatus(REDEEM_TRY_AGAIN, 'gmail')}
            smsHref={null}
            formAction="#preview"
          />
        );
      case 'already-connected':
        return (
          <StatusCard copy={connectedStatus('own_link', 'gmail', { name: 'Sam' })} smsHref={null} />
        );
      case 'missing-link':
        return <StatusCard copy={missingLink()} smsHref={sms} />;
      case 'disconnect':
        return <DisconnectPreview />;
    }
  })();

  return <ConnectStage>{body}</ConnectStage>;
}
