import type { ToolCard } from '@hale/agent';

/**
 * Pure display logic for the connector cards Ask Hale streams (Drive files,
 * Calendar agenda, the not-connected empty state). Kept separate from the React
 * component so the shaping — mime → label, ISO → friendly date/time — is unit
 * tested without a DOM. Rule #1: these functions only ever read the whitelisted
 * card fields (name/mimeType/modifiedTime/webViewLink; title/start/end/location);
 * there is no field for raw content or a token to reach.
 */

/** A short, human file-type label from a Drive mimeType. Falls back to a generic
 * "File" so an unmapped type reads cleanly rather than dumping the raw mime. */
export function driveFileKind(mimeType: string): string {
  const MAP: Record<string, string> = {
    'application/vnd.google-apps.document': 'Doc',
    'application/vnd.google-apps.spreadsheet': 'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.form': 'Form',
    'application/vnd.google-apps.folder': 'Folder',
    'application/pdf': 'PDF',
  };
  if (MAP[mimeType]) return MAP[mimeType];
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  return 'File';
}

/** A friendly "modified" date ("Jun 12, 2026") from an ISO timestamp. Returns ''
 * for an empty/invalid value so the row simply omits the date rather than showing
 * "Invalid Date". */
export function formatModified(iso: string, locale = 'en-CA'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Parse a bare `YYYY-MM-DD` into a LOCAL-time date (its literal calendar day),
 * not a UTC instant — so an all-day event isn't shifted by the viewer's timezone.
 * Returns null for a malformed value. */
function dateFromCalendarDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** One agenda row's day + time-range labels for the calendar card. An all-day event
 * (a `date`-only value, no time component) reads "All day"; a timed event reads a
 * "9:00 AM – 10:30 AM" range. Returns '' fields on an invalid value so the row still
 * renders its title. */
export function formatAgendaRow(
  start: string,
  end: string,
  locale = 'en-CA',
): { day: string; time: string } {
  // An all-day event's `start` is a bare YYYY-MM-DD (Google's `date` field) — a
  // calendar date with NO timezone. It must render as that literal day; parsing it
  // through `new Date('YYYY-MM-DD')` assumes UTC midnight and would shift a viewer
  // behind UTC to the day BEFORE. So an all-day date is dated from its Y/M/D parts
  // in local time. Timed events (`dateTime`) carry a real instant, dated as-is.
  const allDay = start.length > 0 && !start.includes('T');
  const startDate = allDay ? dateFromCalendarDate(start) : new Date(start);
  if (!start || !startDate || Number.isNaN(startDate.getTime())) return { day: '', time: '' };
  const day = startDate.toLocaleDateString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  if (allDay) return { day, time: 'All day' };
  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  };
  const startTime = fmtTime(start);
  const endTime = end ? fmtTime(end) : '';
  const time = endTime ? `${startTime} – ${endTime}` : startTime;
  return { day, time };
}

/** The honest not-connected copy for a provider — the model already relays this in
 * prose; the card mirrors it with a Settings affordance. */
export function notConnectedCopy(provider: 'gdrive' | 'gcal'): {
  service: string;
  line: string;
} {
  const service = provider === 'gdrive' ? 'Google Drive' : 'Google Calendar';
  return { service, line: `Connect ${service} in Settings to let Hale look here.` };
}

/** Narrowers so the component (and its tests) switch on card kind without casting. */
export function isDriveCard(card: ToolCard): card is Extract<ToolCard, { kind: 'drive' }> {
  return card.kind === 'drive';
}
export function isCalendarCard(card: ToolCard): card is Extract<ToolCard, { kind: 'calendar' }> {
  return card.kind === 'calendar';
}
