import type { Metadata } from 'next';
import { SettingsIndex } from '~/components/portal/settings-index';
import { DEMO_BASE, DEMO_SIGN_IN, demoMaskedPhone } from '~/lib/portal/demo-fixture';

export const metadata: Metadata = { title: 'Settings' };

export default function DemoSettingsPage() {
  return (
    <SettingsIndex
      gmailOn={false}
      calendarOn={false}
      name="Pat"
      maskedPhone={demoMaskedPhone}
      canSignOut={false}
      signOutTo={DEMO_SIGN_IN}
      basePath={DEMO_BASE}
    />
  );
}
