import type { DeleteAccountRole } from '~/components/hale/delete-account-button';
import { PrivacyView } from '~/components/portal/privacy-view';
import { DEMO_BASE } from '~/lib/portal/demo-fixture';

const DEMO_ROLE: DeleteAccountRole = 'primary_parent';

export default function DemoPrivacyPage() {
  return <PrivacyView records={[]} role={DEMO_ROLE} basePath={DEMO_BASE} />;
}
