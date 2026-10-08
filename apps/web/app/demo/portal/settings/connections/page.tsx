import { ConnectionsView } from '~/components/portal/connections-view';
import { DEMO_BASE, demoMaskedPhone } from '~/lib/portal/demo-fixture';

export default function DemoConnectionsPage() {
  return (
    <ConnectionsView
      connections={[]}
      assistants={[]}
      maskedPhone={demoMaskedPhone}
      textsOn
      gmailSince={null}
      calendarSince={null}
      driveSince={null}
      basePath={DEMO_BASE}
    />
  );
}
