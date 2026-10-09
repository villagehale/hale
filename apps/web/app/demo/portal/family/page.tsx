import { PortalFamily } from '~/components/portal/family-view';
import { demoBasics, demoMembers } from '~/lib/portal/demo-fixture';

export default function DemoFamilyPage() {
  return (
    <PortalFamily members={demoMembers} basics={demoBasics} openInvite={null} teenGrants={[]} />
  );
}
