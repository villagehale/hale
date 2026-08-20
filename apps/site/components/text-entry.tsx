import { CopyNumberButton } from '~/components/copy-number';
import { EmailCta } from '~/components/email-cta';
import { QrCode } from '~/components/qr-code';
import { TextEntryAnalytics } from '~/components/text-entry-analytics';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { CONTACT_CARD_PATH } from '~/lib/contact-card';
import { CONTACT_EMAIL, buildSmsBody, buildSmsHref } from '~/lib/text-entry';

/**
 * The /text entry surface (VIL-240 · M5) — what a QR card at an EarlyON drop-in,
 * a swim lobby, or a daycare foyer opens, and now also what a parent's forwarded
 * referral link opens. Persona-led and deliberately thin: one thing to do, no
 * account, no form, no way back into the funnel.
 *
 * The `?s=` tag is therefore either a venue or a `friend-…` referral code, which is
 * why the line under the button says "where you came from" rather than naming a
 * spot: a friend is not a place, and the disclosure has to be true of both.
 *
 * Two honest states, driven by whether the SMS number is provisioned:
 *   live  → "Text me" opens the composer pre-filled; the number and a QR of the
 *           same sms: URI cover desktop, where sms: links do nothing.
 *   unset → email is the only path, and the page says the number is coming.
 *           Never a dead sms: link. (Today's state.)
 */
export function TextEntry({
  source,
  smsNumber,
  locale = routing.defaultLocale,
}: {
  source: string | null;
  smsNumber: string;
  locale?: Locale;
}) {
  const t = getTranslator(locale, 'Text');
  const copy = getTranslator(locale, 'CopyNumber');
  const ec = getTranslator(locale, 'EmailCta');
  const smsHref = smsNumber ? buildSmsHref(smsNumber, source) : null;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="shell flex min-h-dvh max-w-[44rem] flex-col justify-center py-16 sm:py-20"
    >
      <TextEntryAnalytics source={source} />

      <div className="rise rise-1">
        <span className="font-serif text-[1.35rem] font-semibold leading-none text-spruce" translate="no">
          Hale
        </span>
        {/* The QR card's landing is the highest-intent surface the site has, so it
            wears the same display face as every other headline rather than the
            base sans — the one page that looked like a different product. */}
        <h1 className="v4-display mt-6 text-[clamp(2rem,6.5vw,3.25rem)]">{t('headline')}</h1>
        <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
          {t('lede')}
        </p>
      </div>

      {smsHref ? (
        <div className="mt-10 rise rise-2">
          <a href={smsHref} className="btn-primary">
            {t('textMe')}
          </a>
          <p className="meta mt-4">
            {source
              ? t('prefilledWithSource', { body: buildSmsBody(source) })
              : t('prefilledNoSource')}
          </p>

          {/* Saved once, every later Hale text arrives with the turtle and a name
              on it. Only offered while the number is live — the card is the
              number, and /hale.vcf 404s without one. */}
          <div className="mt-6">
            <a href={CONTACT_CARD_PATH} className="btn-secondary">
              {t('saveContact')}
            </a>
          </div>

          <div className="card mt-8 flex flex-col gap-6 sm:flex-row sm:items-center">
            <QrCode value={smsHref} label={t('qrAria')} />
            <div>
              <span className="eyebrow">{t('onLaptop')}</span>
              <p className="mt-2">
                <CopyNumberButton
                  number={smsNumber}
                  className="link font-medium"
                  label={copy('labelTitleCase')}
                  copiedLabel={copy('copied')}
                  ariaLabel={copy('aria')}
                />
              </p>
              <p className="meta mt-2">{t('scanHint')}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-10 rise rise-2">
          <EmailCta
            email={CONTACT_EMAIL}
            buttonClassName="btn-primary"
            emailMeLabel={ec('emailMe')}
            copyLabel={ec('copy', { email: CONTACT_EMAIL })}
            copiedLabel={ec('copied')}
          />
          <p className="meta mt-4">{t('numberComing')}</p>
        </div>
      )}

      <p className="meta mt-14 rise rise-3">
        {t('footerPre')}{' '}
        <a href={localeHref(locale, '/privacy')} className="link">
          {t('privacyLink')}
        </a>
        .
      </p>
    </main>
  );
}
