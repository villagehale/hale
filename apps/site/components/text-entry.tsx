import { CopyNumberButton } from '~/components/copy-number';
import { EmailCta } from '~/components/email-cta';
import { LandingCta } from '~/components/landing-cta';
import { QrCode } from '~/components/qr-code';
import { TextEntryAnalytics } from '~/components/text-entry-analytics';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { type Platform, qrLeads } from '~/lib/chooser';
import { CONTACT_CARD_PATH } from '~/lib/contact-card';
import { intakePrefill } from '~/lib/intake-prefill';
import { CONTACT_EMAIL, buildSmsHref, smsUriFormForPlatform } from '~/lib/text-entry';

/**
 * The /text conversion column (VIL-240 · M5) — what a QR card, a poster, a
 * forwarded referral, or the site's own CTAs open. Persona-led and thin: one
 * thing to do, no account, no form. The page (app/[locale]/text/page.tsx)
 * wraps this in the shared SiteHeader and SiteFooter; the turtle lockup lives
 * there, the same assets the landing wears. This column does not draw a
 * second wordmark.
 *
 * One "Text Hale" button, warm-hello prefill. WhatsApp is not a door.
 *
 * THE FIVE-SECOND FRAME (founder brief 2026-09-01, redesigned 2026-09-16): a
 * stranger off a poster QR reads what Hale IS (headline + lede) and then sees
 * the whole transaction as an EXCHANGE — the message they are about to send
 * beside the reply Hale really sends back, byte-pinned to
 * apps/web/lib/channel/intake/copy.ts by app/text-page-copy.test.ts. Composer
 * as hero: the numbered steps are folded into one line under it, because the
 * exchange shows the first beat and the greeting asks for the second.
 * The page never invents Hale speech: ZH shows the English reply under a
 * translated label because copy.ts has no Chinese greeting. When
 * FIRST_TOUCH_LADDER_ENABLED is exactly on, the received bubble is that
 * ladder's first message: the iMessage sentence on Apple phone and Mac, the
 * postal-code sentence on every other platform. The "(via <code>)"
 * attribution token rides ONLY inside composer hrefs; on the page it is
 * disclosed in words (prefilledWithSource), never printed raw — the sent bubble
 * shows the locale's prefill itself, tokenless. FR sends
 * {@link INTAKE_PREFILL_FR}; ZH keeps the English hello.
 *
 * The one withholding is `sms:` on non-Apple desktop, where the link is a dead
 * click and the QR of the same URI leads instead.
 *
 * The `?s=` tag is a venue or `friend-…` referral code; its `(via <code>)` token
 * rides in the pre-filled body of EVERY channel href (poster attribution is
 * sacred), and the line under the buttons discloses it rather than smuggling it.
 *
 * Two honest states:
 *   SMS live  → one tap, except where sms: is a dead click (qrLeads), where
 *               the QR card leads and there is no button.
 *   SMS unset → email is the only path. Never a dead sms: link.
 */

export function TextEntry({
  source,
  smsNumber,
  platform = 'unknown',
  locale = routing.defaultLocale,
  firstTouchLadder = false,
}: {
  source: string | null;
  smsNumber: string;
  /** The server's UA reading (lib/chooser.ts). */
  platform?: Platform;
  locale?: Locale;
  /** VIL-385. The received bubble matches the ladder's first message. */
  firstTouchLadder?: boolean;
}) {
  const t = getTranslator(locale, 'Text');
  const common = getTranslator(locale, 'Common');
  const copy = getTranslator(locale, 'CopyNumber');
  const ec = getTranslator(locale, 'EmailCta');
  const prefill = intakePrefill(locale);
  /** The tap is on a known OS, so the button uses the form that OS reads. The
   * QR stays `cross`: the phone that scans a laptop is not the laptop. */
  const buttonForm = smsUriFormForPlatform(platform);
  const live = smsNumber !== '';

  /** The laptop card: the SMS URI as a scannable code (any phone
   * can finish what a desktop can't), plus the number onto the clipboard. On
   * non-Apple desktop this IS the hero and renders above the buttons. */
  const desktopCard = live ? (
    <div className="card mt-8 hidden flex-col gap-6 sm:flex sm:flex-row sm:items-center">
      <QrCode value={buildSmsHref(smsNumber, source, prefill, 'cross')} label={t('qrAria')} />
      <div>
        <span className="eyebrow">{t('onLaptop')}</span>
        <p className="mt-2">
          <CopyNumberButton
            number={smsNumber}
            placement="text_entry"
            className="link font-medium"
            label={copy('label')}
            copiedLabel={copy('copied')}
            ariaLabel={copy('aria')}
          />
        </p>
        <p className="meta mt-2">{t('scanHint')}</p>
      </div>
    </div>
  ) : null;

  /** THE EXCHANGE — the page's hero since the 2026-09-16 redesign. What the
   * parent is about to send (the locale's prefill verbatim, the composer's own
   * body minus the `(via …)` token, which stays in the href) and what Hale really
   * sends back. Both bubbles are the LANDING's primitives (v4-bubble), so the
   * two surfaces speak one messaging idiom.
   *
   * Each side is captioned in the future tense: nothing here has happened yet,
   * and a reader must never take the received bubble for a text already sitting
   * on their phone. That caption is `aria-hidden` where it sits and repeated
   * sr-only INSIDE its own bubble (the landing does the same with its speaker
   * names), so the framing travels with the message rather than depending on
   * two <p>s staying adjacent — and no reader hears it twice. The ZH
   * previewLabel carries its own "(English original)" because copy.ts has no
   * Chinese greeting.
   *
   * The sent bubble is the literal SMS body. EN sends {@link INTAKE_PREFILL},
   * FR sends {@link INTAKE_PREFILL_FR}. ZH keeps the English body and glosses
   * it — there is no locked Chinese line to send. The gloss renders only when
   * it differs from that body.
   *
   * Only where a channel is live: the dark page promises no text back. */
  const sentLabel = t('sentLabel');
  const previewLabel = t('previewLabel');
  const sentGloss = t('sentGloss');
  const messagesPipe = platform === 'apple' || platform === 'desktop-mac';
  const haleFirst = firstTouchLadder
    ? t(messagesPipe ? 'greetingLadderImessage' : 'greetingLadderSms')
    : t('greeting');
  const exchange = live ? (
    <div className="v4-thread text-thread mt-8">
      <p className="text-thread-label text-thread-label-out" aria-hidden="true">
        {sentLabel}
      </p>
      <p className="v4-bubble v4-bubble-out">
        <span className="sr-only">{sentLabel} </span>
        {prefill}
      </p>
      {sentGloss !== prefill && <p className="text-thread-gloss">{sentGloss}</p>}
      <p className="text-thread-label" aria-hidden="true">
        {previewLabel}
      </p>
      <p className="v4-bubble v4-bubble-in">
        <span className="sr-only">{previewLabel} </span>
        {haleFirst}
      </p>
    </div>
  ) : null;

  return (
    <section className="shell max-w-[44rem] pt-10 pb-16 sm:pt-16 sm:pb-24">
      <TextEntryAnalytics deviceHint={platform} channelsLive={live ? 'sms' : 'none'} />

      <div className="rise rise-1">
        <h1 className="v4-display text-[clamp(2rem,6.5vw,3.25rem)]">{t('headline')}</h1>
        <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
          {t('lede')}
        </p>
        {exchange}
        {live && (
          <p className="mt-5 text-slate-green" style={{ lineHeight: 1.6 }}>
            {t('afterSend')}
          </p>
        )}
      </div>

      {live ? (
        <div className="mt-10 rise rise-2">
          {qrLeads(platform) ? <div className="mb-8">{desktopCard}</div> : null}

          {!qrLeads(platform) && (
            <LandingCta
              event="cta_text_click"
              placement="text_entry"
              channel="sms"
              href={buildSmsHref(smsNumber, source, prefill, buttonForm)}
              className="btn-primary"
            >
              {common('textHale')}
            </LandingCta>
          )}

          {/* The attribution disclosure, in words — the raw "(via <code>)" token
              stays inside the composer hrefs and never renders as page copy. */}
          <p className="meta mt-4">{source ? t('prefilledWithSource') : t('prefilledNoSource')}</p>

          {/* Saved once, every later Hale text arrives with the turtle and a name
              on it. Only offered while the number is live — the card is the
              number, and /hale.vcf 404s without one. */}
          <div className="mt-6">
            <LandingCta
              event="save_contact_click"
              href={CONTACT_CARD_PATH}
              className="btn-secondary"
            >
              {t('saveContact')}
            </LandingCta>
          </div>

          {qrLeads(platform) ? null : desktopCard}

          {/* The trust strip — the four flat facts. Live arms only: "reply
              STOP" needs a number to stop. The privacy policy is linked once,
              on the Canada line below, not again at the end of this strip. */}
          <p className="meta mt-8">{t('trustLine')}</p>
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

      {/* The one privacy link in this column. `nowrap` because ZH has no
          spaces: 隐私政策 otherwise breaks across two lines mid-label. */}
      <p className="meta mt-14 rise rise-3">
        {t('footerPre')}{' '}
        <a href={localeHref(locale, '/privacy')} className="link whitespace-nowrap">
          {t('privacyLink')}
        </a>
        .{live && <> {t('termsLine')}</>}
      </p>
    </section>
  );
}
