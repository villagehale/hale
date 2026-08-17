import { LandingV4 } from '~/components/landing/v4/landing-v4';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com. One landing, unconditionally — the liquid-glass shore (v4).
 * The conversational landing it replaced is retired as the live page; the flag
 * matrix that carried the pivot is long gone.
 *
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down.
 */
export default function LandingPage() {
  return <LandingV4 smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />;
}
