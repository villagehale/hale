import Link from 'next/link';
import { Bell, MapPin } from 'lucide-react';
import { Icon } from '~/components/ui/icon';

/**
 * The desktop top bar that sits inside the main column, above the scrolling stage
 * (design handoff §3.2). Its left is a hero slot pages fill in later phases (page
 * title + subtitle, or a breadcrumb + back); for now it just holds the row height.
 * Its right carries the family's real location and the notification bell.
 *
 * Location is a STATIC pill of the family's stored city — the interactive
 * saved-areas popover arrives with a later backend seam. With no city stored we
 * render nothing rather than a placeholder label (rule #1: never fabricate). The
 * bell links to the existing Messages surface; its dropdown lands in a later phase.
 *
 * Desktop-only via CSS (.app-topbar); the mobile sticky running head + hamburger
 * still own the narrow-viewport frame.
 */
export function AppTopBar({ city }: { city: string | null }) {
  return (
    <div className="app-topbar">
      <div className="app-topbar-hero" />
      <div className="app-topbar-actions">
        {city ? (
          <span className="location-pill">
            <Icon as={MapPin} size={16} />
            <span data-hale-pii>{city}</span>
          </span>
        ) : null}
        <Link
          href="/messages"
          className="topbar-bell"
          aria-label="Notifications"
          title="Notifications"
        >
          <Icon as={Bell} size={20} />
        </Link>
      </div>
    </div>
  );
}
