import { redirect } from 'next/navigation';
import { DEMO_BASE } from '~/lib/portal/demo-fixture';

export default function DemoPortalIndex() {
  redirect(`${DEMO_BASE}/home`);
}
