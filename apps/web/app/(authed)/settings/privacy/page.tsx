import type { Metadata } from 'next';
import { PrivacyView } from '~/components/portal/privacy-view';
import { listConsentRecordsForViewer } from '~/lib/consent-records';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId, listSeatsForUser } from '~/lib/family';
import { deleteAccountRole } from '~/lib/rights/delete-role';

export const metadata: Metadata = { title: 'Privacy & data' };

export default async function PrivacyPage() {
  const database = db();
  const [familyId, userId] = await Promise.all([
    currentFamilyId(database),
    currentUserId(database),
  ]);
  const [records, seats] = await Promise.all([
    userId ? listConsentRecordsForViewer(database, userId) : Promise.resolve([]),
    userId ? listSeatsForUser(userId, database) : Promise.resolve([]),
  ]);
  return <PrivacyView records={records} role={deleteAccountRole(seats, familyId)} />;
}
