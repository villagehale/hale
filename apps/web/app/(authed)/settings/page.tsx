import type { Metadata } from 'next';
import { SettingsIndex } from '~/components/portal/settings-index';
import { authConfigured } from '~/lib/auth-config';
import { loadSmsChannel } from '~/lib/channels/sms-consent';
import { loadViewerProfile } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { LegacySettingsPage } from './legacy-settings';

function on(connections: { provider: string; status: string }[], provider: string): boolean {
  return connections.some((row) => row.provider === provider && row.status !== 'revoked');
}

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  if (!receiptsIaEnabled()) return LegacySettingsPage();

  const [profile, connections, smsChannel] = await Promise.all([
    loadViewerProfile(),
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
      name={profile?.name ?? null}
      maskedPhone={masked}
      canSignOut={authConfigured()}
    />
  );
}
