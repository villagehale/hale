import { smsSegments } from '~/lib/channel/sms-segments';
import type { RenderedContent, VoiceOutcome } from '~/lib/channel/types';
import type { ChildNameLevel } from '~/lib/loop/prefs';
import { gsmSafe } from '../weekly-plan/core';
import { eventLine, whenLeadFor } from './core';
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

/**
 * The reminder's own voice fold, exported so the outcome is assertable.
 *
 * `payload.voice.line` is composed at the evening converge tick from the SAME redacted
 * view this renderer draws on — teen-gated, sensitive-genericized, name-leveled — so it
 * needs no second privacy gate here. payload.ts called it "email-only" and the SMS
 * renderer simply ignored it; reading it is a read of a field that is already there.
 *
 * THE FOLD IS ONE SEGMENT, not the two-segment ceiling. A reminder is a GLANCE: the
 * module header promises it targets one segment and only the overflow paths spend a
 * second. A human sentence is worth having when there is room for it in the glance, and
 * is not worth doubling the message for — so the line rides only when the whole thing
 * still fits one, and the deterministic budget is otherwise untouched.
 *
 * FOUR CONDITIONS, and each one is a way this slot silently went wrong without it
 * (docs/voice.md, "The two SMS folds"):
 *
 *  (a) BYTE IDENTITY after gsmSafe. The folder maps a genuinely unmappable character to
 *      NOTHING (weekly-plan/core.ts), so a composed line with an emoji in it arrives on
 *      the wire a word short and every counter still reads "sent". Comparing the folded
 *      string to the composed one is the only check that can see a deletion.
 *  (b) ZERO QUESTIONS. Not "at most one": a reminder states a fact about the next hour and
 *      owns no answer, so a question appended to it invites a bare YES that the approvals
 *      resolver claims family-wide (docs/voice.md rule 11). reminder-voice.md says nothing
 *      about the wire, so this is the only place it is true.
 *  (c) THE DETERMINISTIC LEAD STILL LEADS — STRUCTURALLY, WHICH IS WHY THERE IS NO THIRD
 *      CHECK HERE. `whenLeadFor` IS the fact this message carries — "Tomorrow", "In an
 *      hour" — and voice.line is not guaranteed to carry it, so the voice is APPENDED to
 *      the rendered body, which already opens with the lead. "The offset went missing" is
 *      therefore not a state this code has: a check for it would compare this function's
 *      own concatenation against its own prefix, and could only ever fail for a caller
 *      that passed a lead the body never had. The property is asserted where it can
 *      genuinely break — on the rendered wire, in index.test.ts.
 *  (d) THE GLANCE. One segment, measured on the whole thing.
 *
 * Every refusal is NAMED (VoiceOutcome, channel/types.ts) and carried out of the renderer.
 */
export function foldReminderVoice(
  body: string,
  composed: string | null | undefined,
): { text: string; outcome: VoiceOutcome } {
  const trimmed = composed?.trim() ?? '';
  if (trimmed === '') return { text: body, outcome: 'absent' };
  if (gsmSafe(trimmed) !== trimmed) return { text: body, outcome: 'refused:gsm_dropped' };
  if (trimmed.includes('?')) return { text: body, outcome: 'refused:question_count' };
  const voiced = gsmSafe(`${body} ${trimmed}`);
  return smsSegments(voiced) <= 1
    ? { text: voiced, outcome: 'used' }
    : { text: body, outcome: 'refused:over_segment' };
}

export function renderReminderSms(
  payload: ReminderPayload,
  level: ChildNameLevel,
  now: Date,
  familyId: string,
): RenderedContent {
  const lead = whenLeadFor(payload.offset, familyId, payload.events[0]?.startsAt, payload.timeZone);
  const lines = payload.events.map((event) =>
    eventLine(event, payload.children, level, now, payload.timeZone),
  );
  const inline = gsmSafe(`${lead}: ${lines.join(LINE_SEP)}`);
  if (smsSegments(inline) > 1) {
    // Already over the glance on the facts alone — the voice has no room by definition,
    // and the overflow paths own the two-segment ceiling. STILL NAMED: a composed line
    // that never got measured is a line that did not ship, and folding that into the same
    // silence as "nothing was composed" is what the outcome exists to stop. The refusal is
    // the segment budget whatever the line says, because the glance was spent before it.
    return {
      kind: 'sms',
      text: cappedText(lead, lines, payload.deepLink),
      voice: (payload.voice?.line ?? '').trim() === '' ? 'absent' : 'refused:over_segment',
    };
  }
  const folded = foldReminderVoice(inline, payload.voice?.line);
  return { kind: 'sms', text: folded.text, voice: folded.outcome };
}
