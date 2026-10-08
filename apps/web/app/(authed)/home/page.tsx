import { PortalHome } from '~/components/portal/home-view';
import { buildThreadItems, zoneDayKeys } from '~/components/portal/thread';
import { haleTextsHref } from '~/lib/channel/connect/hale-texts-href';
import {
  loadFamilyBasics,
  loadFamilyTimezone,
  loadPendingApprovals,
  loadTrail,
} from '~/lib/dashboard/queries';
import { loadViewerName } from '~/lib/family';
import { receiptsIaEnabled } from '~/lib/flags/receipts-ia';
import { loadFamilyConnectors } from '~/lib/integrations/load';
import { loadMessages } from '~/lib/messages/queries';
import { loadLoopNotificationPrefs } from '~/lib/settings/loop-prefs';
import { LegacyHomePage } from './legacy-home';

export default async function HomePage() {
  if (!receiptsIaEnabled()) return LegacyHomePage();

  const [name, approvals, messages, trail, basics, connections, loop, timeZone] = await Promise.all(
    [
      loadViewerName(),
      loadPendingApprovals(),
      loadMessages(),
      loadTrail(),
      loadFamilyBasics(),
      loadFamilyConnectors(),
      loadLoopNotificationPrefs(),
      loadFamilyTimezone(),
    ],
  );
  const { today, yesterday } = zoneDayKeys(timeZone);
  const lately = buildThreadItems(trail, messages, today, yesterday).slice(0, 4).reverse();
  const firstName = name?.trim().split(/\s+/)[0] ?? null;

  return (
    <PortalHome
      firstName={firstName}
      approvals={approvals}
      lately={lately}
      basics={basics}
      connections={connections}
      loop={loop}
      smsHref={haleTextsHref()}
    />
  );
}
