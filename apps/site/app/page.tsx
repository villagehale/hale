import { ConversationalLanding } from '~/components/landing/conversational';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com. One landing, unconditionally — the flag matrix that carried
 * the pivot (village → chief of staff → this) is retired along with both pages
 * it switched between.
 *
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down.
 */
export default function LandingPage() {
  return (
    <ConversationalLanding smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />
  );
}
