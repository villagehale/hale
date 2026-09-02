import { CopyNumberButton } from '~/components/copy-number';
import { EmailCta } from '~/components/email-cta';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { QrCode } from '~/components/qr-code';
import { TextEntryAnalytics } from '~/components/text-entry-analytics';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { type ChannelId, type Platform, channelOrder, qrLeads } from '~/lib/chooser';
import { CONTACT_CARD_PATH } from '~/lib/contact-card';
import { CONTACT_EMAIL, buildSmsHref, buildWaHref } from '~/lib/text-entry';

/**
 * The /text entry surface (VIL-240 · M5) — what a QR card, a poster, a
 * forwarded referral, or the site's own CTAs open. Persona-led and thin: one
 * thing to do, no account, no form, no site chrome.
 *
 * THE PICKER GATE: the channel chooser exists only while WhatsApp is actually
 * live (`whatsappNumber` validates). Until the Twilio WhatsApp sender is
 * approved, production is PR 566 — one "Message Hale" button, "Hi Hale"
 * prefill. An empty iMessage/WhatsApp chooser is a dead door.
 *
 * THE FIVE-SECOND FRAME (founder brief 2026-09-01): a stranger off a poster QR
 * must read what Hale IS (headline + lede), what to DO (three light steps),
 * and what comes BACK — a bubble carrying Hale's CURRENT first reply, byte-
 * pinned to apps/web/lib/channel/intake/copy.ts by app/text-page-copy.test.ts.
 * The page never invents Hale speech: ZH shows the English reply under a
 * translated label because copy.ts has no Chinese greeting. The "(via <code>)"
 * attribution token rides ONLY inside composer hrefs; on the page it is
 * disclosed in words (prefilledWithSource), never printed raw.
 *
 * When both pipes are live, lib/chooser.ts orders them: liveness gates (a dark
 * channel renders NOTHING), and the UA hint only ORDERS. The one withholding
 * is `sms:` on non-Apple desktop, where the link is a dead click and the QR
 * of the same URI leads instead.
 *
 * The `?s=` tag is a venue or `friend-…` referral code; its `(via <code>)` token
 * rides in the pre-filled body of EVERY channel href (poster attribution is
 * sacred), and the line under the buttons discloses it rather than smuggling it.
 *
 * Three honest states:
 *   SMS live, WhatsApp dark → 566 one-tap — except where sms: is a dead click
 *                              (qrLeads), where the QR card leads and no button.
 *   both live               → the chooser.
 *   SMS unset               → email is the only path. Never a dead sms: link.
 */

/** The WhatsApp glyph (Simple Icons path, brand green on a white plate). The
 * brand colour is exempt from the amber-fill-only rule the same way the QR's
 * fixed dark-on-light plate is (qr-code.tsx): a mark another company owns is not
 * ours to retint. */
const WHATSAPP_GLYPH =
  'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413';

/**
 * The handoff visual — the chooser's one signature element: the messaging app's
 * tile, an arrow, Hale's tile. The left tile is a NEUTRAL speech bubble drawn in
 * site tokens (never a clone of Apple's green Messages icon — trademark, and the
 * honesty rule: the label says "Messages", the art claims no vendor) — except
 * when WhatsApp is the primary channel, whose official glyph we may show.
 * Decorative; the headline under it carries the meaning.
 */
function HandoffVisual({ primary }: { primary: ChannelId | undefined }) {
  return (
    <div className="mt-8 flex items-center gap-3" aria-hidden="true">
      {primary === 'whatsapp' ? (
        <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="#ffffff" />
          <path d={WHATSAPP_GLYPH} fill="#25D366" transform="translate(14 14) scale(1.5)" />
        </svg>
      ) : (
        <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0" aria-hidden="true">
          <rect width="64" height="64" rx="14" fill="var(--color-sky-tint)" />
          <path
            d="M22 17h20a8 8 0 0 1 8 8v8a8 8 0 0 1-8 8H31l-8 7v-7h-1a8 8 0 0 1-8-8v-8a8 8 0 0 1 8-8Z"
            fill="var(--color-navy)"
          />
        </svg>
      )}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--color-slate-green)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0"
        aria-hidden="true"
      >
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </svg>
      <span
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[14px]"
        style={{ background: 'var(--color-apricot-tint)' }}
      >
        <LogoMark size={40} />
      </span>
    </div>
  );
}

export function TextEntry({
  source,
  smsNumber,
  whatsappNumber = '',
  platform = 'unknown',
  locale = routing.defaultLocale,
}: {
  source: string | null;
  smsNumber: string;
  /** '' while the WhatsApp sender is unprovisioned (readWhatsAppNumber) — the
   * button then simply does not exist, the same honesty rule as the sms: link. */
  whatsappNumber?: string;
  /** The server's UA reading — ordering input only (lib/chooser.ts). */
  platform?: Platform;
  locale?: Locale;
}) {
  const t = getTranslator(locale, 'Text');
  const common = getTranslator(locale, 'Common');
  const copy = getTranslator(locale, 'CopyNumber');
  const ec = getTranslator(locale, 'EmailCta');
  const live = smsNumber !== '';
  const waLive = whatsappNumber !== '';
  /** A picker only exists when there is a second live pipe. WhatsApp dark is
   * 566 one-tap — never "Pick where we talk" over a single (or empty) choice. */
  const picker = live && waLive;

  const channels = picker ? channelOrder(platform, { sms: true, wa: true }) : [];
  const hrefFor = (id: ChannelId): string =>
    id === 'messages' ? buildSmsHref(smsNumber, source) : buildWaHref(whatsappNumber, source);
  const primary = channels[0];
  const secondary = channels[1];

  /** One anchor per live channel, wired into the funnel with its pipe named. */
  const channelCta = (id: ChannelId, isPrimary: boolean) => (
    <LandingCta
      event={id === 'messages' ? 'cta_text_click' : 'cta_whatsapp_click'}
      placement="text_entry"
      channel={id === 'messages' ? 'sms' : 'whatsapp'}
      href={hrefFor(id)}
      className={
        isPrimary ? 'btn-primary w-full text-center sm:w-auto' : 'btn-secondary text-center'
      }
    >
      {isPrimary
        ? t(id === 'messages' ? 'continueMessages' : 'continueWhatsapp')
        : t(id === 'messages' ? 'orMessages' : 'orWhatsapp')}
    </LandingCta>
  );

  /** The laptop card: the primary channel's URI as a scannable code (any phone
   * can finish what a desktop can't), plus the number onto the clipboard. On
   * non-Apple desktop this IS the hero and renders above the buttons. */
  const desktopCard = live ? (
    <div className="card mt-8 hidden flex-col gap-6 sm:flex sm:flex-row sm:items-center">
      <QrCode
        value={primary ? hrefFor(primary) : buildSmsHref(smsNumber, source)}
        label={t('qrAria')}
      />
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

  /** What comes back — Hale's real first reply, honestly labeled. Only where a
   * channel is live: the dark page promises no text back. */
  const previewBubble = live ? (
    <div className="mt-8">
      <p className="meta">{t('previewLabel')}</p>
      <p
        className="mt-3 max-w-[30rem] rounded-[18px] rounded-bl-[4px] px-5 py-4 text-spruce"
        style={{ background: 'var(--color-apricot-tint)', lineHeight: 1.55 }}
      >
        {t('greeting')}
      </p>
    </div>
  ) : null;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="shell flex min-h-dvh max-w-[44rem] flex-col justify-center py-16 sm:py-20"
    >
      <TextEntryAnalytics
        deviceHint={platform}
        channelsLive={live ? (whatsappNumber ? 'sms+whatsapp' : 'sms') : 'none'}
      />

      <div className="rise rise-1">
        <Wordmark className="text-spruce" />
        {picker && <HandoffVisual primary={primary} />}
        {/* Highest-intent surface: display face, not the base sans. 566 headline
            until WhatsApp is live — the chooser copy is a picker, not a CTA. */}
        <h1 className="v4-display mt-6 text-[clamp(2rem,6.5vw,3.25rem)]">
          {t(picker ? 'chooserHeadline' : 'headline')}
        </h1>
        <p className="mt-6 text-lg text-slate-green" style={{ lineHeight: 1.6 }}>
          {t(picker ? 'chooserLede' : 'lede')}
        </p>
        {/* The chooser keeps its own lede (the picker disclosure), so the
            what-is line rides underneath it — same words as the one-tap arm. */}
        {picker && (
          <p className="mt-3 text-slate-green" style={{ lineHeight: 1.6 }}>
            {t('lede')}
          </p>
        )}
        {/* What to DO — three beats, a light numbered row (one-tap arm; the
            chooser's job is picking a pipe, not re-teaching the steps). */}
        {live && !picker && (
          <ol className="mt-8 grid gap-2.5">
            {(['step1', 'step2', 'step3'] as const).map((key, index) => (
              <li key={key} className="flex gap-3">
                <span
                  className="w-5 shrink-0 text-right font-display text-spruce"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="text-slate-green" style={{ lineHeight: 1.6 }}>
                  {t(key)}
                </span>
              </li>
            ))}
          </ol>
        )}
        {previewBubble}
      </div>

      {live ? (
        <div className="mt-10 rise rise-2">
          {qrLeads(platform) ? <div className="mb-8">{desktopCard}</div> : null}

          {picker ? (
            primary !== undefined && (
              <div className="flex flex-col items-start gap-3">
                {channelCta(primary, true)}
                {secondary !== undefined && channelCta(secondary, false)}
              </div>
            )
          ) : (
            !qrLeads(platform) && (
              <LandingCta
                event="cta_text_click"
                placement="text_entry"
                channel="sms"
                href={buildSmsHref(smsNumber, source)}
                className="btn-primary"
              >
                {common('messageHale')}
              </LandingCta>
            )
          )}

          {/* The attribution disclosure, in words — the raw "(via <code>)" token
              stays inside the composer hrefs and never renders as page copy. */}
          <p className="meta mt-4">
            {source ? t('prefilledWithSource') : t('prefilledNoSource')}
          </p>

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

          {/* The trust strip — the four flat facts plus the one link that backs
              them up. Live arms only: "reply STOP" needs a number to stop. */}
          <p className="meta mt-8">
            {t('trustLine')} ·{' '}
            <a href={localeHref(locale, '/privacy')} className="link">
              {t('privacyLink')}
            </a>
          </p>
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
        .{live && <> {t('termsLine')}</>}
      </p>
    </main>
  );
}
