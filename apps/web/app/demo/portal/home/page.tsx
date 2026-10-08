import { PortalHome } from '~/components/portal/home-view';
import { DEMO_BASE, demoBasics, demoLoop, demoSmsHref } from '~/lib/portal/demo-fixture';

export default function DemoHomePage() {
  return (
    <PortalHome
      firstName="Pat"
      approvals={[]}
      lately={[]}
      basics={demoBasics}
      connections={[]}
      loop={demoLoop}
      smsHref={demoSmsHref()}
      basePath={DEMO_BASE}
    />
  );
}
