import { asciiSpaces } from '~/lib/channel/intake/radar-decide';
import { townLabel } from '~/lib/channel/intake/radar-voice';
import { formatWhenPhrase } from '~/lib/format/datetime';
import type { SequenceLeg, SequenceOptIn } from './schedule.js';
import type { FitNote, Shortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — every sentence the sequence can send, rendered deterministically.
 *
 * NO MODEL RUNS IN THIS FILE, and unlike M4's nudge that is not a fallback path — it is
 * the whole design. Two reasons, and the second is the one that settles it:
 *
 *   1. There is nothing here for a model to add. Every leg is a time, a link and a list
 *      of names; the warmth a composer buys on a weekend suggestion is worth very little
 *      on "your registration opens in 15 minutes".
 *   2. These messages arrive at 6:15 a.m. through a QUIET-HOURS EXEMPTION the parent
 *      granted by approving a shortlist. A message with that privilege has to be one a
 *      human reviewed once and can predict forever. A generated sentence with a
 *      quiet-hours bypass is a sentence nobody approved waking a household for.
 *
 * Plain ASCII throughout: one typographic dash or curly apostrophe flips the whole SMS
 * to UCS-2 and halves the budget (see sms-segments.ts). The `asciiSpaces` wrapper exists
 * because Intl renders "6:30 a.m." with a NARROW NO-BREAK SPACE, which is not GSM-7.
 */

export interface LegCopyInput {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  optIn: SequenceOptIn;
  /** Present only for the two waitlist guards. */
  waitlist?: { position: number | null; deadlineAt: Date | null };
}

export type CheckInReplyRender =
  | { outcome: 'registered' }
  | { outcome: 'waitlisted'; position: number | null; deadlineAt: Date | null }
  | { outcome: 'missed' }
  /** Nothing readable came back — the single gentle re-ask. */
  | { outcome: null };

export interface CheckInReplyInput {
  shortlist: Shortlist;
  timeZone: string;
  now: Date;
  reply: CheckInReplyRender;
}

/** The three answers the reply parser can actually read, quoted verbatim so a parent
 * who copies one back is guaranteed a match. */
const ANSWER_MENU = 'Reply "got in", "waitlisted #12" or "missed it".';

function when(instant: Date, timeZone: string, now: Date): string {
  return asciiSpaces(formatWhenPhrase(instant, timeZone, now));
}

/** Just the time of day, for a leg whose sentence already carries the day. */
function timeOfDay(instant: Date, timeZone: string): string {
  return asciiSpaces(
    new Intl.DateTimeFormat('en-CA', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(instant),
  );
}

function joinNames(names: readonly string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Who the window is for, in one phrase. A 13+ child is counted, never named (rule #1) —
 * the generic wording is what M8 established for a teenager's own paperwork, and the
 * reason is identical: the deadline is real whether or not Hale may say the name.
 */
function whoPhrase(fitNotes: readonly FitNote[]): string {
  const named = fitNotes.map((note) => note.name).filter((name): name is string => name !== null);
  const teens = fitNotes.length - named.length;
  const parts: string[] = [];
  if (named.length > 0) parts.push(joinNames(named));
  if (teens > 0) parts.push(teens === 1 ? 'your teen' : 'your teens');
  return parts.join(' and ');
}

/** "Richmond Hill Fall 2026 recreation programs" — the window, as a parent reads it. */
function windowPhrase(shortlist: Shortlist): string {
  return `${townLabel(shortlist.windowRef.municipality)} ${shortlist.windowRef.cycleLabel} ${shortlist.programDomainLabel}`;
}

function headsUp(input: LegCopyInput): string {
  const { shortlist } = input;
  const who = whoPhrase(shortlist.fitNotes);
  const resident =
    shortlist.isResidentWindow && shortlist.residentPriorityDays !== null
      ? ' Your postal code gets the residents-first date.'
      : '';
  // The hedge is load-bearing: the match may rest on the +/-6-month tolerance the
  // matcher grants a DOB derived from a spoken age, so asserting the band would be
  // asserting something Hale does not know.
  const hedge = shortlist.ageApproximate ? ' Worth a look if that is still their band.' : '';
  const cta =
    input.optIn === 'opted_in'
      ? ' I will send your plan the evening before.'
      : ' Open Hale to approve the shortlist and I will run the morning with you.';
  return `${windowPhrase(shortlist)} registration opens ${when(shortlist.opensForFamilyAt, input.timeZone, input.now)} for ${who}.${resident}${hedge}${cta}`;
}

function battlePlan(input: LegCopyInput): string {
  const { shortlist } = input;
  return `Tomorrow: ${windowPhrase(shortlist)} opens ${timeOfDay(shortlist.opensForFamilyAt, input.timeZone)} for ${whoPhrase(shortlist.fitNotes)}. Sign in tonight and have this open: ${shortlist.sourceUrl}`;
}

function go(input: LegCopyInput): string {
  const { shortlist } = input;
  return `${windowPhrase(shortlist)} opens ${timeOfDay(shortlist.opensForFamilyAt, input.timeZone)}. Your link: ${shortlist.sourceUrl}`;
}

function checkIn(input: LegCopyInput): string {
  return `How did ${windowPhrase(input.shortlist)} go? ${ANSWER_MENU}`;
}

/**
 * The waitlist guards. Both say WHERE the clock came from, because it came from two
 * places a parent should be able to separate: the response window is the
 * municipality's published rule, and the start is the parent's own message. Hale never
 * sees the offer email, so claiming to know when the offer landed would be a guess
 * dressed as a deadline.
 */
function waitlistGuard(input: LegCopyInput, leg: 'waitlist_half' | 'waitlist_final'): string {
  const hours = input.shortlist.waitlistResponseHours;
  const deadline = input.waitlist?.deadlineAt ?? null;
  const town = townLabel(input.shortlist.windowRef.municipality);
  if (hours === null || deadline === null) {
    // The scheduler never emits a guard without a clock; this keeps the renderer total
    // rather than throwing inside a send path.
    return `Checking in on your ${town} waitlist spot - watch your email for an offer.`;
  }
  const until = `${when(deadline, input.timeZone, input.now)}`;
  if (leg === 'waitlist_final') {
    return `About 2h left to answer a ${town} waitlist offer: ${hours}h from your message runs out ${until}. Check your email and portal.`;
  }
  return `Halfway on the ${town} waitlist clock. Their window is ${hours}h from your message, so it runs out ${until}.`;
}

/** One leg's SMS body, without the opt-out — the sender appends that exactly once. */
export function renderSequenceLeg(leg: SequenceLeg, input: LegCopyInput): string {
  switch (leg) {
    case 'heads_up':
      return headsUp(input);
    case 'battle_plan':
      return battlePlan(input);
    case 'go':
      return go(input);
    case 'check_in':
      return checkIn(input);
    case 'waitlist_half':
    case 'waitlist_final':
      return waitlistGuard(input, leg);
  }
}

/** Hale's answer to what the parent reported. Solicited, so no opt-out line. */
export function renderCheckInReply(input: CheckInReplyInput): string {
  const { shortlist, reply } = input;
  const town = townLabel(shortlist.windowRef.municipality);
  if (reply.outcome === 'registered') {
    return `That is a spot. Noted: ${town} ${shortlist.windowRef.cycleLabel} registered.`;
  }
  if (reply.outcome === 'missed') {
    return `Sorry - that one filled. Noted, and I will flag the next ${town} window early.`;
  }
  if (reply.outcome === null) {
    return `Sorry, I did not catch that. ${ANSWER_MENU}`;
  }
  const spot = reply.position === null ? 'Waitlisted' : `Waitlisted #${reply.position}`;
  if (shortlist.waitlistResponseHours === null || reply.deadlineAt === null) {
    return `${spot}, noted. ${town} has no published response window, so I cannot set a clock - watch your email closely.`;
  }
  return `${spot}, noted. ${town} gives ${shortlist.waitlistResponseHours}h to answer an offer, so I will nudge you before ${when(reply.deadlineAt, input.timeZone, input.now)}.`;
}

/**
 * The shortlist as the parent sees it in their approvals queue. Longer than an SMS
 * because it is read on a screen and it is the thing being consented to — the approval
 * is what unlocks the two quiet-hours-exempt legs, so it has to state plainly what it
 * will cause.
 */
export function renderShortlistRationale(
  shortlist: Shortlist,
  timeZone: string,
  now: Date,
): string {
  const lines = [
    `${windowPhrase(shortlist)} registration opens ${when(shortlist.opensForFamilyAt, timeZone, now)}.`,
    `Register here: ${shortlist.sourceUrl}`,
  ];
  if (shortlist.isResidentWindow && shortlist.residentPriorityDays !== null) {
    lines.push(
      `Your postal code gets the residents-first date, ${shortlist.residentPriorityDays} days ahead of the general open.`,
    );
  }
  for (const note of shortlist.fitNotes) {
    const who = note.name ?? 'Your teen';
    lines.push(
      note.fit === 'in_band'
        ? `${who} is inside the published age band.`
        : `${who} is just outside the published age band, within the margin on an approximate birthday.`,
    );
  }
  lines.push(
    'Approving this asks me to text you a week ahead, the evening before, and 15 minutes before it opens. I never register for you.',
  );
  return lines.join('\n');
}
