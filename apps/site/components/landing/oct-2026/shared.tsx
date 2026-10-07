import { UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { ChooserLink } from '~/components/chooser-link';
import { CopyNumberButton } from '~/components/copy-number';
import { LandingCta } from '~/components/landing-cta';
import { QrCode } from '~/components/qr-code';
import type { Locale } from '~/i18n/routing';
import { type Platform, qrLeads } from '~/lib/chooser';
import { CONTACT_CARD_PATH } from '~/lib/contact-card';
import { intakePrefill } from '~/lib/intake-prefill';
import {
  CONTACT_EMAIL,
  buildSmsHref,
  readSmsNumber,
  smsUriFormForPlatform,
} from '~/lib/text-entry';

export function DesignCta({
  locale,
  className,
  children,
}: { locale: Locale; className?: string; children: ReactNode }) {
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  return number ? (
    <ChooserLink
      locale={locale}
      placement="landing_redesign"
      className={className}
      smsNumber={number}
      prefill={intakePrefill(locale)}
    >
      {children}
    </ChooserLink>
  ) : (
    <a className={className} href={`mailto:${CONTACT_EMAIL}`}>
      Email Hale
    </a>
  );
}

export interface DesignTextEntry {
  number: string;
  source: string | null;
  platform: Platform;
  greeting: string;
}

export function DesignTextDoor({
  number,
  source,
  platform,
  className,
  children,
}: DesignTextEntry & { className?: string; children: ReactNode }) {
  if (!number)
    return (
      <a className={className} href={`mailto:${CONTACT_EMAIL}`}>
        Email Hale
      </a>
    );
  if (qrLeads(platform))
    return (
      <a className={className} href="#start">
        {children}
      </a>
    );
  return (
    <LandingCta
      event="cta_text_click"
      channel="sms"
      placement="text_entry"
      className={className}
      href={buildSmsHref(number, source, intakePrefill('en'), smsUriFormForPlatform(platform))}
    >
      {children}
    </LandingCta>
  );
}

export function DesignQr({ number, source }: DesignTextEntry) {
  if (!number) return null;
  return (
    <div className="hs-glass sp-qr hs-desktop-only">
      <QrCode value={buildSmsHref(number, source, intakePrefill('en'), 'cross')} size={136} />
      <div>
        <h3 className="hs-h3">On a laptop?</h3>
        <p className="hs-p">
          Scan the code with your phone’s camera, or copy the number and text it from your phone.
        </p>
        <div className="sp-qr-actions">
          <CopyNumberButton
            number={number}
            placement="text_entry"
            className="sp-btn2"
            label="Copy number"
            copiedLabel="Copied"
            ariaLabel="Copy Hale’s phone number"
          />
          <a href={CONTACT_CARD_PATH} className="sp-btn2" download>
            <UserRound size={14} aria-hidden="true" /> Save to contacts
          </a>
        </div>
      </div>
    </div>
  );
}
