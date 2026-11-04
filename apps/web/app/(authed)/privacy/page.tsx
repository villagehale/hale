import type { Metadata } from 'next';
import { PrivacyPageView } from '~/components/portal/privacy-page-view';
import { loadWhatHaleDid } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId, listSeatsForUser } from '~/lib/family';
import { connectionState } from '~/lib/integrations/connection-state';
import { listUserConnections } from '~/lib/integrations/store';
import { deleteAccountRole } from '~/lib/rights/delete-role';

export const metadata: Metadata = { title: 'Privacy & data' };

export default async function PrivacyPage() {
  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  // The viewer's own connections: the revoke key, so a co-parent's Gmail never reads
  // as the viewer's.
  const [activity, connections, seats] = await Promise.all([
    loadWhatHaleDid(),
    familyId && userId ? listUserConnections(database, familyId, userId) : Promise.resolve([]),
    userId ? listSeatsForUser(userId, database) : Promise.resolve([]),
  ]);

  return (
    <PrivacyPageView
      activity={activity}
      connections={{
        gmail: connectionState(connections, 'gmail'),
        gcal: connectionState(connections, 'gcal'),
        gdrive: connectionState(connections, 'gdrive'),
      }}
      role={deleteAccountRole(seats, familyId)}
    />
  );
}
