import { Mail, Phone } from 'lucide-react';
import type { LoadSmsChannelResult } from '~/lib/channels/sms-consent';
import { SettingsCard, SettingsRow } from './settings-card';

/**
 * "How Hale reaches you" — the contact channels the store can actually back:
 * SMS (from the sms loader's real result — enrolled + masked number, or an honest
 * absent state) and email (the users row, nullable for phone-claim accounts).
 * Informational rows only: linking a number lives under Account, so there is no
 * dead Connect button here — and no WhatsApp row, because nothing renderable
 * backs one (rule #1). Masked number and address are replay-masked.
 */
export function ConnectionChannelsCard({
  sms,
  email,
}: {
  sms: LoadSmsChannelResult;
  email: string | null;
}) {
  const enrolled = sms.status === 'ready' && sms.channel.enrolled && sms.channel.maskedPhone !== null;
  const smsValue =
    sms.status !== 'ready'
      ? 'Sign in to link a number.'
      : enrolled
        ? `Enrolled · ${sms.channel.maskedPhone}`
        : sms.senderConfigured
          ? 'Not linked yet — add your number under Account.'
          : 'Texting isn’t switched on yet.';

  return (
    <SettingsCard>
      <SettingsRow icon={Phone} label="Text messages" value={smsValue} pii={enrolled} />
      <SettingsRow
        icon={Mail}
        label="Email"
        value={email ?? 'No email on file — you sign in with your number.'}
        pii={email !== null}
      />
    </SettingsCard>
  );
}
