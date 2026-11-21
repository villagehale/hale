import { CheckoutPending } from '~/components/checkout/checkout-pending';
import { CopyNumberButton } from '~/components/copy-number';
import { QrCode } from '~/components/qr-code';
import { TextDoor } from '~/components/redesign/text-door';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL } from '~/lib/app-url';
import {
  type CheckoutSuccessView,
  billingThreadNoticesEnabled,
} from '~/lib/billing/checkout-success';
import { type Platform, messagesCapable } from '~/lib/chooser';
import { intakePrefill } from '~/lib/intake-prefill';
import { CONTACT_EMAIL, buildSmsHref, displaySmsNumber } from '~/lib/text-entry';

const OPENS_THE_COMPOSER: readonly Platform[] = ['apple', 'android'];

/**
 * The checkout success page, one state per buyer. Whoever holds the URL sees this, so
 * only the active plan shows a name, and that name sits in `ph-no-capture` so a session
 * replay records a blank box instead.
 */
export function CheckoutState({
  view,
  locale,
  sessionId,
  smsNumber,
  platform,
}: {
  view: CheckoutSuccessView;
  locale: Locale;
  sessionId: string | null;
  smsNumber: string;
  platform: Platform;
}) {
  const t = getTranslator(locale, 'CheckoutSuccess');
  const sentenceGap = locale === 'zh' ? '' : ' ';
  const opener = intakePrefill(locale);
  const heading = (text: string) => <h1 className="sp-h1">{text}</h1>;
  const textHale = (prefill: string | null) => (
    <TextDoor
      className="btn btn-hero"
      placement="checkout_success"
      locale={locale}
      smsNumber={smsNumber}
      prefill={prefill}
      mode="sms"
    >
      {t('textHale')}
    </TextDoor>
  );
  // Without a composer the door would be /text, the page that starts a new parent off.
  const openThread = messagesCapable(platform) ? textHale(null) : null;
  const openHale = (
    <a className="sp-btn2" href={`${APP_URL}/settings#billing`}>
      {t('continue')}
    </a>
  );
  const emailUs = (
    <a className="sp-btn2" href={`mailto:${CONTACT_EMAIL}`}>
      {t('emailUs')}
    </a>
  );
  const numberLine = smsNumber ? (
    <p className="sp-number">{t('number', { number: displaySmsNumber(smsNumber) })}</p>
  ) : null;
  const notFound = (lede: string) => (
    <>
      {heading(t('unpaidHeading'))}
      <p className="sp-lede">{lede}</p>
      <div className="sp-cta">
        <a className="btn btn-hero" href={localeHref(locale, '/pricing')}>
          {t('seePricing')}
        </a>
        {emailUs}
      </div>
    </>
  );

  switch (view.state) {
    case 'plan_active':
      return (
        <>
          {heading(t('plan', { plan: view.plan }))}
          <p className="sp-lede">
            {view.firstName ? (
              <span className="ph-no-capture">{t('thanksNamed', { name: view.firstName })}</span>
            ) : (
              t('thanks')
            )}
            {sentenceGap}
            {t('keepTexting')}
            {view.checkInDue && billingThreadNoticesEnabled()
              ? `${sentenceGap}${t('checkIn')}`
              : null}
          </p>
          <div className="sp-cta">
            {openThread}
            {openHale}
          </div>
        </>
      );
    case 'upgraded':
      return (
        <>
          {heading(t('upgradedHeading'))}
          <p className="sp-lede">{t('upgradedLede')}</p>
          <div className="sp-cta">
            {openThread}
            {openHale}
          </div>
        </>
      );
    case 'already_on_plan':
      return (
        <>
          {heading(t('alreadyHeading', { plan: view.plan }))}
          <p className="sp-lede">{t('alreadyLede')}</p>
          <div className="sp-cta">{openHale}</div>
        </>
      );
    case 'new_visitor':
      if (OPENS_THE_COMPOSER.includes(platform)) {
        return (
          <>
            {heading(t('heading'))}
            <p className="sp-lede">{t('lede')}</p>
            <div className="sp-cta">{textHale(opener)}</div>
            {numberLine}
            <div className="sp-cta">{openHale}</div>
          </>
        );
      }
      return (
        <>
          {heading(t('heading'))}
          <p className="sp-lede">{t('startFromPhone')}</p>
          {smsNumber ? (
            <div
              className="hs-glass sp-qr"
              style={{
                margin: 'var(--s6) auto 0',
                padding: 'var(--s5)',
                width: 'min(640px, 100%)',
              }}
            >
              <QrCode
                value={buildSmsHref(smsNumber, null, opener, 'cross')}
                label={t('startFromPhone')}
              />
              <div>
                {numberLine}
                <p className="hs-p">{opener}</p>
                <div
                  className="sp-cta"
                  style={{ marginTop: 'var(--s4)', justifyContent: 'flex-start' }}
                >
                  <CopyNumberButton
                    number={smsNumber}
                    placement="checkout_success"
                    className="sp-btn2"
                    label={t('copyNumber')}
                    copiedLabel={t('copied')}
                    ariaLabel={t('copyNumber')}
                  />
                  <CopyNumberButton
                    number={smsNumber}
                    text={opener}
                    placement="checkout_success_opener"
                    className="sp-btn2"
                    label={t('copyMessage')}
                    copiedLabel={t('copied')}
                    ariaLabel={t('copyMessage')}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="sp-cta">{textHale(opener)}</div>
          )}
          <div className="sp-cta">{openHale}</div>
        </>
      );
    case 'pending':
      return (
        <>
          {heading(t('pendingHeading'))}
          {sessionId ? (
            <CheckoutPending
              sessionId={sessionId}
              lede={t('pendingLede')}
              slowLede={t('pendingSlowLede')}
            />
          ) : (
            <p className="sp-lede">{t('pendingSlowLede')}</p>
          )}
        </>
      );
    case 'under_review':
      return (
        <>
          {heading(t('pendingHeading'))}
          <p className="sp-lede">{t('pendingSlowLede')}</p>
          <div className="sp-cta">
            {openHale}
            {emailUs}
          </div>
        </>
      );
    case 'receipt':
      return (
        <>
          {heading(t('unpaidHeading'))}
          <p className="sp-lede">{t('receiptLede')}</p>
          <div className="sp-cta">
            {openHale}
            {emailUs}
          </div>
        </>
      );
    case 'not_paid':
      return notFound(`${t('notFoundLede')}${sentenceGap}${t('notCharged')}`);
    case 'unknown':
      return notFound(t('notFoundLede'));
  }
}
