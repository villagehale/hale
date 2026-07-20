import type { RootHero, RootRoute } from '~/components/hale/hero-map';
import { LocationSwitcher } from '~/components/hale/location-switcher';
import { NotificationBell } from '~/components/hale/notification-bell';
import { PageHero } from '~/components/hale/page-hero';
import type { NotificationItem } from '~/lib/dashboard/notifications';
import type { AreaSwitcherData } from '~/lib/village/switcher';

/**
 * The desktop top bar inside the main column (design handoff §3.2). Left: the single
 * page hero (h1 + subtitle for a tab root, or breadcrumb + back for a drill-in) —
 * pages no longer render their own header, so this can never duplicate one. Right: the
 * live location switcher (real saved areas + city search) and the notification bell
 * (real approvals + notes; opening marks read).
 *
 * Desktop-only via CSS (.app-topbar); the mobile stage hero + running head own the
 * narrow-viewport frame.
 */
export function AppTopBar({
  roots,
  notifications,
  areaData,
}: {
  roots: Record<RootRoute, RootHero>;
  notifications: NotificationItem[];
  areaData: AreaSwitcherData;
}) {
  return (
    <div className="app-topbar">
      <div className="app-topbar-hero">
        <PageHero roots={roots} variant="topbar" />
      </div>
      <div className="app-topbar-actions">
        <LocationSwitcher data={areaData} />
        <NotificationBell items={notifications} />
      </div>
    </div>
  );
}
