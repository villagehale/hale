import type { ToolCard } from './coach-fold';

/**
 * Pure display logic for the connector cards Hale streams (Drive files, Calendar
 * agenda, the not-connected empty state) — the mobile mirror of the web
 * apps/web/lib/coach/connector-card.ts, kept as pure functions so the shaping is
 * unit-tested without rendering. Rule #1: these only read the whitelisted card
 * fields; there is no field for raw content or a token to reach.
 */

/** A short, human file-type label from a Drive mimeType. Falls back to "File". */
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

/** A friendly "modified" date from an ISO timestamp, or '' when empty/invalid. */
export function formatModified(iso: string, locale = 'en-CA'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Parse a bare `YYYY-MM-DD` into a LOCAL-time date (its literal calendar day),
 * not a UTC instant — so an all-day event isn't shifted by the viewer's timezone. */
function dateFromCalendarDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** One agenda row's day + time-range labels. All-day → "All day"; timed → a range.
 * An all-day date is dated from its Y/M/D parts in local time so the viewer's
 * timezone can't shift it to the day before. */
export function formatAgendaRow(
  start: string,
  end: string,
  locale = 'en-CA',
): { day: string; time: string } {
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

/** The honest not-connected copy for a provider. */
export function notConnectedCopy(provider: 'gdrive' | 'gcal'): { service: string; line: string } {
  const service = provider === 'gdrive' ? 'Google Drive' : 'Google Calendar';
  return { service, line: `Connect ${service} in Settings to let Hale look here.` };
}

/** Every tool_result activity entry that carries a card, in order — the slice the
 * chat renders as connector cards under a settled Hale turn. */
export function cardsFromActivity(activity: Array<{ card?: ToolCard }>): ToolCard[] {
  return activity.flatMap((a) => (a.card ? [a.card] : []));
}
