import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ConnectionsView } from '~/components/portal/connections-view';
import { loadSmsChannel } from '~/lib/channels/sms-consent';
import { loadFamilyTimezone } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { listMcpConnectionsForUser } from '~/lib/mcp/oauth-store';

export const metadata: Metadata = { title: 'Connections' };

function monthDay(value: Date | undefined, timeZone: string): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(value);
}

export default async function ConnectionsPage() {
  if (!receiptsIaEnabled()) redirect('/settings#apps');

  const database = db();
  const [connections, timeZone, smsChannel, familyId, userId] = await Promise.all([
    loadFamilyConnectors(),
    loadFamilyTimezone(),
    loadSmsChannel(),
    currentFamilyId(database),
    currentUserId(database),
  ]);
  const assistants =
    familyId && userId ? await listMcpConnectionsForUser(database, familyId, userId) : [];
  const row = (provider: string) =>
    connections.find(
      (item) => item.provider === provider && item.status !== 'revoked' && item.ownedByViewer,
    );

  return (
    <ConnectionsView
      connections={connections}
      assistants={assistants}
      maskedPhone={
        smsChannel.status === 'ready' && smsChannel.channel.enrolled
          ? smsChannel.channel.maskedPhone
          : null
      }
      textsOn={smsChannel.status === 'ready' && smsChannel.channel.enrolled}
      gmailSince={monthDay(row('gmail')?.connectedAt, timeZone)}
      calendarSince={monthDay(row('gcal')?.connectedAt, timeZone)}
      driveSince={monthDay(row('gdrive')?.connectedAt, timeZone)}
    />
  );
}
