import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { DeleteAccountRole } from '~/components/hale/delete-account-button';
import { PrivacyView } from '~/components/portal/privacy-view';
import { listConsentRecordsForViewer } from '~/lib/consent-records';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId, listSeatsForUser } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';

export const metadata: Metadata = { title: 'Privacy & data' };

export default async function PrivacyPage() {
  if (!receiptsIaEnabled()) redirect('/settings#trust');

  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  const [records, seats] = await Promise.all([
    userId ? listConsentRecordsForViewer(database, userId) : Promise.resolve([]),
    userId ? listSeatsForUser(userId, database) : Promise.resolve([]),
  ]);
  const viewerRole = seats.find((seat) => seat.familyId === familyId)?.role ?? null;
  const role: DeleteAccountRole =
    seats.length > 1
      ? 'ambiguous'
      : seats.length === 1 && viewerRole === 'co_parent'
        ? 'co_parent'
        : viewerRole === null || viewerRole === 'primary_parent'
          ? 'primary_parent'
          : 'scoped';

  return <PrivacyView records={records} role={role} />;
}
