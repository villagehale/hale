import type { Database } from '@hale/db';
import type { Metadata } from 'next';
import { PrivacyPageView } from '~/components/portal/privacy-page-view';
import { isParentRole } from '~/lib/channel/role-scope';
import { loadWhatHaleDid } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId, listSeatsForUser } from '~/lib/family';
import { connectionState } from '~/lib/integrations/connection-state';
import { listUserConnections } from '~/lib/integrations/store';
import { DELETION_GRACE_DAYS } from '~/lib/rights/delete';
import { deleteAccountRole } from '~/lib/rights/delete-role';
import { exportSeat } from '~/lib/rights/export-seat';

export const metadata: Metadata = { title: 'Privacy & data' };

export default async function PrivacyPage() {
  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  const seats = userId ? await listSeatsForUser(userId, database) : [];
  // "What Hale did" is family-wide (recipients, subjects, calendar titles), so only a
  // parent seat in THIS family reads it. A caregiver's scope never covers another
  // adult's mail or calendar, and a viewer with no seat here fails closed.
  const seat = seats.find((candidate) => candidate.familyId === familyId);
  const household =
    familyId && userId && seat && isParentRole(seat.role)
      ? await loadHousehold(database, familyId, userId)
      : null;

  return (
    <PrivacyPageView
      household={household}
      seated={seat !== undefined}
      role={deleteAccountRole(seats, familyId)}
      canExport={exportSeat(seats).outcome === 'export'}
      holdDays={DELETION_GRACE_DAYS}
    />
  );
}

async function loadHousehold(database: Database, familyId: string, userId: string) {
  // The viewer's own connections: the revoke key, so a co-parent's Gmail never reads
  // as the viewer's.
  const [activity, connections] = await Promise.all([
    loadWhatHaleDid(),
    listUserConnections(database, familyId, userId),
  ]);
  return {
    activity,
    connections: {
      gmail: connectionState(connections, 'gmail'),
      gcal: connectionState(connections, 'gcal'),
      gdrive: connectionState(connections, 'gdrive'),
    },
  };
}
