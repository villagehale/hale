import type { CalendarStanding } from '@hale/db';

/**
 * Where the connecting parent stands on one raw Google events.list item. One rule for every
 * calendar reader: the mirror, the 1:1 notice and the household group (VIL-633, VIL-651).
 *
 * Anyone can put an invite on a parent's calendar, so its title is a stranger's words until
 * the parent says yes, and its organizer can rename it after. The parent's own event is one
 * they organized, or one with no organizer named and no one else on it. The attendee list a
 * guest sees can be cut to just their own row (maxAttendees, or a sender who hides the guest
 * list), so a lone `self` row proves nothing: what counts is that row's answer, and only
 * 'accepted' is a yes. An event the parent organized but let its guests edit carries other
 * people's words too, so it stands as accepted.
 */
export function calendarStandingOf(item: Record<string, unknown>): CalendarStanding {
  const organizer = item.organizer as { self?: unknown } | null | undefined;
  const named = typeof organizer === 'object' && organizer !== null;
  if (named && organizer.self === true) {
    return item.guestsCanModify === true ? 'accepted' : 'organizer';
  }
  const attendees = Array.isArray(item.attendees)
    ? item.attendees.filter(
        (row): row is { self?: unknown; responseStatus?: unknown } =>
          typeof row === 'object' && row !== null,
      )
    : [];
  const self = attendees.find((row) => row.self === true);
  if (self?.responseStatus === 'accepted') {
    return named || attendees.some((row) => row.self !== true) ? 'accepted' : 'own';
  }
  return !named && attendees.length === 0 ? 'own' : 'invited';
}
