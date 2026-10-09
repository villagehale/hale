import type { Metadata } from 'next';
import { PortalFamily } from '~/components/portal/family-view';
import { demoBasics, demoMembers } from '~/lib/portal/demo-fixture';

export const metadata: Metadata = { title: 'Family' };

export default function DemoFamilyPage() {
  return (
    <PortalFamily members={demoMembers} basics={demoBasics} openInvite={null} teenGrants={[]} />
  );
}
