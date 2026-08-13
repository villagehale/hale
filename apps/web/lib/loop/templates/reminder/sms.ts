import { smsSegments } from '~/lib/channel/sms-segments';
import type { RenderedContent } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { gsmSafe } from '../weekly-plan/core';
import { eventLine, whenLead } from './core';
import type { ReminderPayload } from './payload';

/**
 * VIL-223 · D1 — the reminder SMS renderer. The tightest channel: a reminder is a
 * glance, so it targets ONE segment and never carries a link on the T-1h ping (rule
 * #6). A T-24h batch that overflows one segment trims its inline list to a "+N more"
 * tail plus the /plan link; a single event whose freeform title is longer than the
 * ceiling gives way at a word boundary. Either way the hard ceiling of two segments
 * holds — it is measured, not assumed, on every path out of here. Folded
 * to GSM-7 once at the end via gsmSafe — the em-dash/middle-dot become their ASCII
 * equivalents, which is what keeps the batch inside the segment budget.
 */

const LINE_SEP = ', ';
const SEGMENT_CAP = 2;
const ELLIPSIS = '...';

/** What follows the inline list: the events it left out, and the /plan link on the
 * offsets that carry one. Neither on a T-1h ping that dropped nothing. */
function tail(more: number, deepLink: string | null): string {
  const parts = [more > 0 ? `+${more} more` : '', deepLink ?? ''].filter((p) => p !== '');
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/** Trim the inline event list to the most that fit alongside a "+N more" tail and the
 * /plan link within the two-segment ceiling — the T-24h overflow path. */
function cappedText(lead: string, lines: readonly string[], deepLink: string | null): string {
  for (let shown = lines.length - 1; shown >= 1; shown--) {
    const inline = lines.slice(0, shown).join(LINE_SEP);
    const text = gsmSafe(`${lead}: ${inline}${tail(lines.length - shown, deepLink)}`);
    if (smsSegments(text) <= SEGMENT_CAP) return text;
  }
  return trimmedFirstLine(lead, lines, deepLink);
}

/**
 * The ceiling when dropping lines cannot reach it: ONE event whose own line is longer
 * than two segments. family_events titles are freeform, so this is a title a parent
 * typed at length, not a rendering bug — and the alternative to giving way at a word
 * boundary is a five-segment reminder, which is the one thing this renderer promises
 * not to send. A batch arrives here too, when its first line alone is over the ceiling.
 */
function trimmedFirstLine(lead: string, lines: readonly string[], deepLink: string | null): string {
  const first = lines[0] ?? '';
  const suffix = tail(lines.length - 1, deepLink);
  const render = (shown: string) => gsmSafe(`${lead}: ${shown}${suffix}`);
  const words = first.split(' ');
  for (let count = words.length - 1; count >= 1; count--) {
    const text = render(`${words.slice(0, count).join(' ')}${ELLIPSIS}`);
    if (smsSegments(text) <= SEGMENT_CAP) return text;
  }
  // A single unbroken token longer than the ceiling. Nothing about it is readable at any
  // length, so it is cut where it fits rather than sent whole.
  for (let end = first.length - 1; end >= 1; end--) {
    const text = render(`${first.slice(0, end)}${ELLIPSIS}`);
    if (smsSegments(text) <= SEGMENT_CAP) return text;
  }
  return render(ELLIPSIS);
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
