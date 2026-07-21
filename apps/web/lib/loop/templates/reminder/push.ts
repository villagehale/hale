import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { eventLine, whenLead } from './core';
import type { ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder push renderer. A lock-screen glance: the title is the
 * lead ("Tomorrow" / "In an hour") and the body is the offset's event line(s) joined
 * inline. The T-24h batch carries the /plan deep link in `data`; the T-1h ping is
 * glanceable and carries NO tap target (rule #6 — no links on the day-of reminder).
 */

const LINE_SEP = ', ';

export function renderReminderPush(
  payload: ReminderPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  const title = whenLead(payload.offset);
  const body = payload.events
    .map((event) => eventLine(event, payload.children, level, now, payload.timeZone))
    .join(LINE_SEP);
  if (payload.offset === '-P1D') {
    return { kind: 'push', title, body, data: { deepLink: payload.deepLink } };
  }
  return { kind: 'push', title, body };
}
