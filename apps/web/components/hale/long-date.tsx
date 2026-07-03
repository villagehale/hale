import { loadFamilyTimezone } from '~/lib/dashboard/queries';
import { formatLongDate } from '~/lib/format/datetime';

/**
 * Compact long date stamp, used as the right-side of the page corner and
 * in section headers. Lower-case typographic style throughout.
 *
 * An async server component: it resolves the family's timezone itself and stamps
 * "now" in that zone, so a parent at 11pm ET never sees the server's (UTC)
 * "tomorrow". Self-sourcing the zone keeps every page-corner caller a bare
 * `<LongDate />` — no timezone prop drilled through ten pages.
 */
export async function LongDate() {
  const timeZone = await loadFamilyTimezone();
  const { weekday, month, day, year } = formatLongDate(new Date(), timeZone);
  return (
    <span className="eyebrow tabular">
      {weekday} · {month} {day} · {year}
    </span>
  );
}
