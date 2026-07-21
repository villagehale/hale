import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { gsmSafe, smsSegments } from '../weekly-plan/core';
import { eventLine, whenLead } from './core';
import type { ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder SMS renderer. The tightest channel: a reminder is a
 * glance, so it targets ONE segment and never carries a link on the T-1h ping (rule
 * #6). Only a T-24h batch that overflows one segment trims its inline list to a
 * "+N more" tail plus the /plan link, held to a hard ceiling of two segments. Folded
 * to GSM-7 once at the end via gsmSafe — the em-dash/middle-dot become their ASCII
 * equivalents, which is what keeps the batch inside the segment budget.
 */

const LINE_SEP = ', ';
const SEGMENT_CAP = 2;

/** Trim the inline event list to the most that fit alongside a "+N more" tail and the
 * /plan link within the two-segment ceiling — the T-24h overflow path. */
function cappedText(lead: string, lines: readonly string[], deepLink: string | null): string {
  for (let shown = lines.length - 1; shown >= 1; shown--) {
    const more = lines.length - shown;
    const inline = lines.slice(0, shown).join(LINE_SEP);
    const tail = deepLink ? ` +${more} more ${deepLink}` : ` +${more} more`;
    const text = gsmSafe(`${lead}: ${inline}${tail}`);
    if (smsSegments(text) <= SEGMENT_CAP || shown === 1) return text;
  }
  return gsmSafe(`${lead}: ${lines.join(LINE_SEP)}`);
}

export function renderReminderSms(
  payload: ReminderPayload,
  level: ChildNameLevel,
  now: Date,
): RenderedContent {
  const lead = whenLead(payload.offset);
  const lines = payload.events.map((event) =>
    eventLine(event, payload.children, level, now, payload.timeZone),
  );
  const inline = gsmSafe(`${lead}: ${lines.join(LINE_SEP)}`);
  const text = smsSegments(inline) <= 1 ? inline : cappedText(lead, lines, payload.deepLink);
  return { kind: 'sms', text };
}
