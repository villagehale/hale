import { redirect } from 'next/navigation';
import { PortalHeading } from '~/components/portal/heading';
import { TextsEditor } from '~/components/portal/texts-editor';
import { loadFamilyBasics } from '~/lib/dashboard/queries';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { DEFAULT_LOOP_PREFS } from '~/lib/loop/prefs';
import { loadLoopNotificationPrefs } from '~/lib/settings/loop-prefs';

export default async function TextsPage() {
  if (!receiptsIaEnabled()) redirect('/settings#notif');

  const [loop, basics] = await Promise.all([loadLoopNotificationPrefs(), loadFamilyBasics()]);
  const prefs = loop.status === 'ready' ? loop.prefs : DEFAULT_LOOP_PREFS;
  const childFirstName = basics.children[0]?.name?.trim() || null;

  return (
    <>
      <PortalHeading back title="Texts from Hale" lede="What Hale texts you, and when." />
      <TextsEditor prefs={prefs} childFirstName={childFirstName} />
    </>
  );
}
