import { SettingsIndex } from '~/components/portal/settings-index';
import { authConfigured } from '~/lib/auth-config';
import { loadSmsChannel } from '~/lib/channels/sms-consent';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { loadViewerProfile } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { LegacySettingsPage } from './legacy-settings';

function on(connections: { provider: string; status: string }[], provider: string): boolean {
  return connections.some((row) => row.provider === provider && row.status !== 'revoked');
}

export default async function SettingsPage() {
  if (!receiptsIaEnabled()) return LegacySettingsPage();

  const [profile, basics, connections, smsChannel] = await Promise.all([
    loadViewerProfile(),
    loadFamilyBasics(),
    loadFamilyConnectors(),
    loadSmsChannel(),
  ]);
  const masked =
    smsChannel.status === 'ready' && smsChannel.channel.enrolled
      ? smsChannel.channel.maskedPhone
      : null;

  return (
    <SettingsIndex
      gmailOn={on(connections, 'gmail')}
      calendarOn={on(connections, 'gcal')}
      planTier={basics.planTier}
      name={profile?.name ?? null}
      maskedPhone={masked}
      canSignOut={authConfigured()}
    />
  );
}
