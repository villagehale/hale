import { deriveStage } from '@hale/types';
import type { Metadata } from 'next';
import { PassportHomeScreen } from '~/components/passport/passport-screens';
import { PortalFamily } from '~/components/portal/family-view';
import { loadOpenJoinInviteForFamily } from '~/lib/channel/join/invites';
import { loadFamilyBasics, loadFamilyMembers } from '~/lib/dashboard/queries';
import { db } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import { interestPassportEnabled } from '~/lib/passport/flag';
import { readPassportModel } from '~/lib/passport/read';
import { listTeenAccessGrants } from '~/lib/teen-access';

export const metadata: Metadata = { title: 'Family' };

export default async function FamilyPage() {
  if (interestPassportEnabled()) {
    const model = await readPassportModel();
    return <PassportHomeScreen model={model} />;
  }

  const database = db();
  const [members, basics, familyId, userId] = await Promise.all([
    loadFamilyMembers(),
    loadFamilyBasics(),
    currentFamilyId(database),
    currentUserId(database),
  ]);
  const openInvite =
    !members.coParent && familyId
      ? await loadOpenJoinInviteForFamily(database, familyId, new Date())
      : null;
  const hasTeen = basics.children.some((child) => deriveStage(child.dateOfBirth) === 'teenager');
  const teenGrants =
    hasTeen && familyId && userId ? await listTeenAccessGrants(database, familyId, userId) : [];

  return (
    <PortalFamily
      members={members}
      basics={basics}
      openInvite={openInvite ? { expiresAt: openInvite.expiresAt.toISOString() } : null}
      teenGrants={teenGrants}
    />
  );
}
