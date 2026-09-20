import type { WeekPlanItem } from '@hale/db';
import { smsSegments } from '~/lib/channel/sms-segments';
import type { RenderedContent } from '~/lib/channel/types';
import { dayAbbrev, gsmSafe, itemsChronological, timeLabel } from '../weekly-plan/core';
import type { CaregiverChild, CaregiverPlanPayload } from './payload';

/**
 * The week a caregiver was promised, and the shorter twin of the parents' weekly SMS.
 *
 * WHAT IT DROPS, and why each one is a decision rather than a trim:
 *
 *   the approval ask   — "2 drafted for your calendar, reply YES" is an instruction to
 *                        the ROUTER, and a caregiver's YES resolves nothing. Printing it
 *                        would be Hale asking a grandmother to approve a booking she
 *                        cannot make.
 *   the /plan link     — a caregiver has no account to open it with (their users row is
 *                        minted from a phone number, with no email and no password), so
 *                        the link is a door with no key.
 *   the quiet-week ask — "A quiet week, nothing scheduled yet. Want ideas for Saturday?"
 *                        is both outside the scope they agreed to and, for them, often
 *                        FALSE: a caregiver's empty list usually means the week was all
 *                        health or all teenager, which is a household that is not quiet
 *                        at all. So an empty week is not rendered here — the sender does
 *                        not enqueue one (see loop/send.ts `skippedNothingInScope`).
 *
 * WHAT IT ADDS: the location. "Where to be, when, and for what" is the caregiver scope
 * in the invite's own words (channel/caregiver/copy.ts), and the parents' renderer never
 * had a reason to print an address the parent already knows.
 *
 * NAMES. This renderer does not consult the recipient's `child_name_level`, and the
 * omission is deliberate. That dial is a per-PARENT render preference on their own
 * loop_prefs row; a caregiver has none, so the documented default would apply — and the
 * default is 'generic', which renders a grandmother's schedule as "your kid" and makes a
 * two-child week unreadable. The privacy floor for a third party is the ROLE SCOPE plus
 * the deterministic teen gate, and both ran before this function was called: a 13+
 * child's items are not in `items` at all. What survives is what the parents named a
 * caregiver in order to hand over.
 */

const MIDDLE_DOT = '·';
const ITEM_SEP = ` ${MIDDLE_DOT} `;
const HEADER_SEP = ' - ';
/** The same three-segment budget the parents' week keeps, measured rather than assumed. */
const SEGMENT_CAP = 3;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/** "This week for Mia and Leo", or the bare "This week" when nothing in scope names a
 * child (a family-wide week — a holiday, a visit).
 *
 * SENTENCE CASE, because it now opens the message: it used to sit after a `Hale: ` label,
 * which is the one context where a lowercase opener reads right (docs/voice.md rules 2
 * and 4). */
function header(items: readonly WeekPlanItem[], children: readonly CaregiverChild[]): string {
  const referenced = new Set(items.flatMap((i) => i.childIds));
  const names = children.filter((c) => referenced.has(c.id)).map((c) => c.name);
  return names.length === 0 ? 'This week' : `This week for ${joinNames([...new Set(names)])}`;
}

/** One item as "Tue 4:15 gymnastics at Stouffville Leisure Centre" — day and time dropped
 * when the item is day-coarse, location dropped when the artifact carries none. */
function itemLine(item: WeekPlanItem): string {
  const parts: string[] = [];
  const day = dayAbbrev(item.startsAt);
  const time = timeLabel(item.startsAt);
  if (day) parts.push(day);
  if (time) parts.push(time);
  parts.push(item.title);
  const line = parts.join(' ');
  return item.location ? `${line} at ${item.location}` : line;
}

export function renderCaregiverPlanSms(payload: CaregiverPlanPayload): RenderedContent {
  const lines = itemsChronological(payload.items).map(itemLine);
  // NO `Hale: ` PREFIX (docs/voice.md rule 2): a caregiver who accepted an invite is in
  // a thread with Hale and knows who is texting. The header survives only where the
  // recipient has no way to know — party/guest-copy.ts.
  const send = (body: string) =>
    gsmSafe(`${header(payload.items, payload.children)}${HEADER_SEP}${body}`);

  const full = send(lines.join(ITEM_SEP));
  if (smsSegments(full) <= SEGMENT_CAP) return { kind: 'sms', text: full };

  // Over budget. There is no "full week" link to fall back on, so the week gives way
  // from the END — the days nearest now are the ones a caregiver is about to need — and
  // says how many it kept back rather than pretending it showed everything.
  for (let shown = lines.length - 1; shown >= 1; shown--) {
    const text = send(`${lines.slice(0, shown).join(ITEM_SEP)}${ITEM_SEP}+${lines.length - shown} more`);
    if (smsSegments(text) <= SEGMENT_CAP) return { kind: 'sms', text };
  }
  return { kind: 'sms', text: send(`${lines.length} things on - ask the parents for the week`) };
}
