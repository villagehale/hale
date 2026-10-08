/**
 * Stamp signal rules. Pure: no database, no model, no copy.
 *
 * An activity stamp comes from a registration or enrollment email for a
 * multi-week program (a session, start and end dates, or a number of weeks).
 * Calendar is a supporting signal only when that email is absent: three or
 * more weekly repeats, one stamp for the season, with progress on it.
 * One-off games, tournaments, birthday parties, and single drop-in classes
 * never get an activity stamp. A one-time outing ticket gets the smaller
 * visit stamp. An unclear signal does not stamp and does not ask.
 */

import { glueMonthDay } from './month-day';

export type StampKind = 'activity' | 'outing';
export type SourceType = 'gmail' | 'calendar' | 'parent' | 'group_share';
export type StampState = 'inferred' | 'confirmed' | 'removed';

export type SkipReason =
  | 'mailbox_not_self_connected'
  | 'teen'
  | 'one_off'
  | 'unclear'
  | 'not_weekly'
  | 'below_floor'
  | 'per_week_or_month'
  | 'name_matches_none'
  | 'no_child'
  | 'tombstone'
  | 'email_owns_it'
  | 'already_present';

export interface ChildRef {
  id: string;
  name: string;
  teenager: boolean;
}

export interface StampDraft {
  kind: StampKind;
  activity: string;
  activityKey: string;
  level: string | null;
  seasonKey: string;
  seasonLabel: string;
  childId: string | null;
  /** A confirm belongs on a text that is already going out. Never a text of its own. */
  ask: boolean;
  weeksTotal: number | null;
  weeksElapsed: number;
  sessionStart: string | null;
  sessionEnd: string | null;
  completed: boolean;
  whenLabel: string | null;
  icon: string;
}

export type GmailDecision =
  | { stamp: false; ask: false; reason: SkipReason }
  | { stamp: true; ask: true; draft: StampDraft };

export interface GmailInput {
  subject: string;
  title: string;
  /**
   * Accepted and ignored. A body, snippet, or quote must not change the decision.
   */
  body?: string | null;
  snippet?: string | null;
  quoteEvidence?: string | null;
  /** Only a confirmation or receipt can stamp. Anything else is not this signal. */
  kind: 'booking_confirmation' | 'other';
  connectedByUserId: string | null;
  actorUserId: string | null;
  teenAttributed: boolean;
  /** Extractor child id. A value that is not one of `children` matches nobody. */
  childRef: string | null;
  children: readonly ChildRef[];
  now: Date;
}

export type CalendarDecision =
  | { stamp: false; ask: false; reason: SkipReason }
  | { stamp: true; ask: true; draft: StampDraft };

export interface CalendarInput {
  title: string;
  occurrences: readonly Date[];
  childRef: string | null;
  teenAttributed: boolean;
  children: readonly ChildRef[];
  now: Date;
}

export interface ExistingStamp {
  childId: string | null;
  activityKey: string;
  seasonKey: string;
  sourceRef: string;
  sourceType: SourceType;
  state: StampState;
}

export type WritePlan =
  | { action: 'skip'; reason: 'tombstone' | 'email_owns_it' | 'already_present' }
  | { action: 'insert' }
  | { action: 'update_progress' };

const ONE_OFF = /\b(tournaments?|birthdays?|parties|party|drop-?ins?|drop\s+ins?|games?)\b/i;
const OUTING_PLACE = /\b(zoo|aquarium|museum|market|farm)\b/i;
const TICKET = /\b(tickets?|admission|day\s+pass|passes|entry)\b/i;
const WEEK_COUNT = /\b(\d{1,2})\s*[-–]?\s*weeks?\b/i;
const SEASON_WORD =
  /\b(fall|autumn|spring|winter|summer)\b(?:\s+(session|term))?(?:\s+(20\d{2}))?/i;
const BELT = /\b(white|yellow|orange|green|blue|purple|brown|black)\s+belt\b/i;
const LEVEL = /\b(pre-primary|beginner|intermediate|advanced)\b/i;

const MONTH_INDEX: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const FACE_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

function signalText(subject: string, title: string): string {
  return `${subject}\n${title}`;
}

export function subjectSnippet(subject: string): string | null {
  const collapsed = subject.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.slice(0, 180);
}

export function activityKeyOf(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return key || 'activity';
}

export function iconFor(text: string): string {
  const t = text.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\baquarium\b/, 'aquarium'],
    [/\bzoo\b/, 'zoo'],
    [/\bmuseum\b/, 'museum'],
    [/christmas|holiday market|\bmarket\b/, 'christmas-market'],
    [/\bfarm\b/, 'farm'],
    [/\bswimming\b|\bswim\b/, 'swimming'],
    [/\bhockey\b/, 'hockey'],
    [/\bfigure skating\b/, 'figure-skating'],
    [/\bskating\b/, 'skating'],
    [/\bsoccer\b|\bfootball\b/, 'soccer'],
    [/\bbasketball\b/, 'basketball'],
    [/\bkarate\b/, 'karate'],
    [/\btaekwondo\b/, 'taekwondo'],
    [/\bballet\b/, 'ballet'],
    [/\bdance\b/, 'dance'],
    [/\bgolf\b/, 'golf'],
    [/\bgymnastics\b/, 'gymnastics'],
    [/\bbaseball\b/, 'baseball'],
    [/\bski\b/, 'skiing'],
    [/\bmma\b/, 'mma'],
  ];
  for (const [pattern, icon] of rules) {
    if (pattern.test(t)) return icon;
  }
  return '';
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

function parseDates(text: string, now: Date): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    const iso = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (iso) found.add(iso);
  }
  const monthRe =
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/gi;
  for (const match of text.matchAll(monthRe)) {
    const month = MONTH_INDEX[match[1]?.toLowerCase() ?? ''];
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : now.getUTCFullYear();
    if (!month) continue;
    const iso = isoDate(year, month, day);
    if (iso) found.add(iso);
  }
  return [...found].sort();
}

function seasonFromMonth(month: number, year: number): { key: string; label: string } {
  if (month === 12 || month <= 2) {
    const y = month === 12 ? year + 1 : year;
    return { key: `winter-${y}`, label: `Winter ${y}` };
  }
  if (month <= 5) return { key: `spring-${year}`, label: `Spring ${year}` };
  if (month <= 8) return { key: `summer-${year}`, label: `Summer ${year}` };
  return { key: `fall-${year}`, label: `Fall ${year}` };
}

function namedSeason(text: string, now: Date): { key: string; label: string } | null {
  const match = SEASON_WORD.exec(text);
  if (!match?.[1]) return null;
  const word = match[1].toLowerCase() === 'autumn' ? 'fall' : match[1].toLowerCase();
  const year = match[3] ? Number(match[3]) : now.getUTCFullYear();
  const label = `${word.charAt(0).toUpperCase()}${word.slice(1)} ${year}`;
  return { key: `${word}-${year}`, label };
}

function weekCount(text: string): number | null {
  const match = WEEK_COUNT.exec(text);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1 || n > 60) return null;
  return n;
}

function spanWeeks(start: string, end: string): number | null {
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (days < 14) return null;
  return Math.min(60, Math.max(2, Math.round(days / 7)));
}

function progressCounts(
  total: number | null,
  start: string | null,
  end: string | null,
  now: Date,
): { weeksElapsed: number; completed: boolean } {
  if (total === null || total < 1) {
    const completed = end !== null && `${isoOf(now)}` > end;
    return { weeksElapsed: 0, completed };
  }
  if (start === null) return { weeksElapsed: 0, completed: false };
  const today = isoOf(now);
  if (today < start) return { weeksElapsed: 0, completed: false };
  const elapsed = Math.min(
    total,
    Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 / 7,
    ) + 1,
  );
  const completed = (end !== null && today > end) || elapsed >= total;
  return { weeksElapsed: Math.max(0, elapsed), completed };
}

function isoOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function activityName(title: string, subject: string): string {
  const raw = (title.trim() || subject.trim()).replace(/^(re|fw|fwd):\s*/i, '');
  const cleaned = raw
    .replace(
      /^(registration confirmed|enrollment confirmed|enrolment confirmed|receipt|payment receipt)\s*[:\-–]\s*/i,
      '',
    )
    .split(/[|]/)[0]
    ?.trim();
  const withoutSeason = (cleaned ?? raw)
    .replace(/\b(fall|autumn|spring|winter|summer)\b(?:\s+(session|term))?(?:\s+20\d{2})?/gi, '')
    .replace(/\b\d{1,2}\s*[-–]?\s*weeks?\b/gi, '')
    .replace(/[,–\-]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (withoutSeason || cleaned || raw).slice(0, 80).trim();
}

function levelOf(text: string): string | null {
  const belt = BELT.exec(text);
  if (belt?.[0]) return belt[0].replace(/\s+/g, ' ');
  const level = LEVEL.exec(text);
  return level?.[0] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assignChild(
  text: string,
  childRef: string | null,
  children: readonly ChildRef[],
):
  | { ok: true; childId: string | null; ambiguous: boolean }
  | { ok: false; reason: 'teen' | 'name_matches_none' | 'no_child' } {
  if (children.length === 0) return { ok: false, reason: 'no_child' };
  if (childRef) {
    const hit = children.find((child) => child.id === childRef);
    if (!hit) return { ok: false, reason: 'name_matches_none' };
    if (hit.teenager) return { ok: false, reason: 'teen' };
    return { ok: true, childId: hit.id, ambiguous: false };
  }
  const named = children.filter((child) => {
    const name = child.name.trim();
    if (!name) return false;
    return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text);
  });
  if (named.length === 1) {
    const only = named[0];
    if (!only) return { ok: false, reason: 'no_child' };
    if (only.teenager) return { ok: false, reason: 'teen' };
    return { ok: true, childId: only.id, ambiguous: false };
  }
  if (named.length > 1) {
    const open = named.filter((child) => !child.teenager);
    if (open.length === 0) return { ok: false, reason: 'teen' };
    if (open.length === 1) {
      const only = open[0];
      if (!only) return { ok: false, reason: 'teen' };
      return { ok: true, childId: only.id, ambiguous: false };
    }
    return { ok: true, childId: null, ambiguous: true };
  }
  const open = children.filter((child) => !child.teenager);
  if (open.length === 0) return { ok: false, reason: 'teen' };
  if (children.length === 1) {
    const only = open[0];
    if (!only) return { ok: false, reason: 'teen' };
    return { ok: true, childId: only.id, ambiguous: false };
  }
  return { ok: true, childId: null, ambiguous: true };
}

function refuse(reason: SkipReason): GmailDecision {
  return { stamp: false, ask: false, reason };
}

export function decideGmail(input: GmailInput): GmailDecision {
  if (!input.connectedByUserId || input.connectedByUserId !== input.actorUserId) {
    return refuse('mailbox_not_self_connected');
  }
  if (input.teenAttributed) return refuse('teen');
  const text = signalText(input.subject, input.title);
  if (ONE_OFF.test(text)) return refuse('one_off');
  if (input.kind !== 'booking_confirmation') return refuse('unclear');

  const dates = parseDates(text, input.now);
  const start = dates[0] ?? null;
  const end = dates.length >= 2 ? (dates[dates.length - 1] ?? null) : null;
  const counted = weekCount(text);
  const spanned = start && end ? spanWeeks(start, end) : null;
  const season = namedSeason(text, input.now);
  const multiWeek = (counted !== null && counted >= 2) || spanned !== null || season !== null;
  const outing = OUTING_PLACE.test(text) && TICKET.test(text);

  if (outing && multiWeek) return refuse('unclear');
  if (!outing && !multiWeek) return refuse('unclear');

  const assigned = assignChild(text, input.childRef, input.children);
  if (!assigned.ok) return refuse(assigned.reason);

  if (outing) {
    const when = start ?? isoOf(input.now);
    const place = outingPlace(text, input.title);
    return {
      stamp: true,
      ask: true,
      draft: {
        kind: 'outing',
        activity: place.name,
        activityKey: activityKeyOf(`${place.name} ${when}`),
        level: null,
        seasonKey: `visit-${when}`,
        seasonLabel: stampFaceDate(when),
        childId: assigned.childId,
        ask: true,
        weeksTotal: null,
        weeksElapsed: 0,
        sessionStart: when,
        sessionEnd: when,
        completed: when < isoOf(input.now),
        whenLabel: null,
        icon: place.icon,
      },
    };
  }

  const weeks = counted !== null && counted >= 2 ? counted : spanned;
  const resolvedSeason =
    season ??
    (start
      ? seasonFromMonth(Number(start.slice(5, 7)), Number(start.slice(0, 4)))
      : seasonFromMonth(input.now.getUTCMonth() + 1, input.now.getUTCFullYear()));
  const counts = progressCounts(weeks, start, end, input.now);
  const name = activityName(input.title, input.subject);
  if (!name) return refuse('unclear');
  return {
    stamp: true,
    ask: true,
    draft: {
      kind: 'activity',
      activity: name,
      activityKey: activityKeyOf(name),
      level: levelOf(text),
      seasonKey: resolvedSeason.key,
      seasonLabel: resolvedSeason.label,
      childId: assigned.childId,
      ask: true,
      weeksTotal: weeks,
      weeksElapsed: counts.weeksElapsed,
      sessionStart: start,
      sessionEnd: end,
      completed: counts.completed,
      whenLabel: null,
      icon: iconFor(`${name} ${text}`),
    },
  };
}

function outingPlace(text: string, title: string): { name: string; icon: string } {
  const icon = iconFor(`${title} ${text}`);
  const titled = title.trim();
  if (titled && OUTING_PLACE.test(titled) && titled.length <= 80) {
    return { name: titled, icon };
  }
  const match = OUTING_PLACE.exec(text);
  const word = match?.[1] ?? 'Visit';
  const name = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return { name, icon: icon || iconFor(name) };
}

function titleUnclear(title: string): boolean {
  const t = title.trim();
  if (t.length < 2) return true;
  return /^(event|busy|hold|untitled|calendar|appointment)$/i.test(t);
}

function perPeriod(title: string): boolean {
  const t = title.trim();
  if (/^(week|month)\s*\d+$/i.test(t)) return true;
  return /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(
    t,
  );
}

function weeklyDays(occurrences: readonly Date[]): Date[] {
  const byDay = new Map<number, Date>();
  for (const occurrence of occurrences) {
    const day = Date.UTC(
      occurrence.getUTCFullYear(),
      occurrence.getUTCMonth(),
      occurrence.getUTCDate(),
    );
    const existing = byDay.get(day);
    if (!existing || occurrence.getTime() < existing.getTime()) byDay.set(day, occurrence);
  }
  return [...byDay.values()].sort((a, b) => a.getTime() - b.getTime());
}

export function decideCalendar(input: CalendarInput): CalendarDecision {
  const title = input.title.trim();
  if (ONE_OFF.test(title)) return { stamp: false, ask: false, reason: 'one_off' };
  if (perPeriod(title)) return { stamp: false, ask: false, reason: 'per_week_or_month' };
  if (titleUnclear(title)) return { stamp: false, ask: false, reason: 'unclear' };
  if (input.teenAttributed) return { stamp: false, ask: false, reason: 'teen' };

  const days = weeklyDays(input.occurrences);
  if (days.length < 3) return { stamp: false, ask: false, reason: 'below_floor' };
  for (let i = 1; i < days.length; i += 1) {
    const prev = days[i - 1];
    const curr = days[i];
    if (!prev || !curr) continue;
    const gap = (curr.getTime() - prev.getTime()) / 86_400_000;
    if (gap < 5 || gap > 9) return { stamp: false, ask: false, reason: 'not_weekly' };
  }

  const assigned = assignChild(title, input.childRef, input.children);
  if (!assigned.ok) return { stamp: false, ask: false, reason: assigned.reason };

  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return { stamp: false, ask: false, reason: 'unclear' };
  const start = first.toISOString().slice(0, 10);
  const end = last.toISOString().slice(0, 10);
  const season = seasonFromMonth(first.getUTCMonth() + 1, first.getUTCFullYear());
  const elapsed = days.filter((day) => day.getTime() <= input.now.getTime()).length;
  const completed = last.getTime() <= input.now.getTime();
  const name = title.slice(0, 80);
  return {
    stamp: true,
    ask: true,
    draft: {
      kind: 'activity',
      activity: name,
      activityKey: activityKeyOf(name),
      level: null,
      seasonKey: season.key,
      seasonLabel: season.label,
      childId: assigned.childId,
      ask: true,
      weeksTotal: days.length,
      weeksElapsed: Math.min(days.length, elapsed),
      sessionStart: start,
      sessionEnd: end,
      completed,
      whenLabel: null,
      icon: iconFor(name),
    },
  };
}

export function planStampWrite(
  existing: readonly ExistingStamp[],
  incoming: {
    childId: string | null;
    activityKey: string;
    seasonKey: string;
    sourceRef: string;
    sourceType: SourceType;
  },
): WritePlan {
  if (incoming.childId) {
    const sameSource = existing.find(
      (row) => row.childId === incoming.childId && row.sourceRef === incoming.sourceRef,
    );
    if (sameSource?.state === 'removed') return { action: 'skip', reason: 'tombstone' };
    const removedSame = existing.find(
      (row) =>
        row.childId === incoming.childId &&
        row.activityKey === incoming.activityKey &&
        row.seasonKey === incoming.seasonKey &&
        row.state === 'removed',
    );
    if (removedSame) return { action: 'skip', reason: 'tombstone' };
    const live = existing.find(
      (row) =>
        row.childId === incoming.childId &&
        row.activityKey === incoming.activityKey &&
        row.seasonKey === incoming.seasonKey &&
        row.state !== 'removed',
    );
    if (live) {
      if (incoming.sourceType === 'calendar' && live.sourceType !== 'calendar') {
        return {
          action: 'skip',
          reason: live.sourceType === 'gmail' ? 'email_owns_it' : 'already_present',
        };
      }
      return { action: 'update_progress' };
    }
    if (sameSource) return { action: 'update_progress' };
  } else {
    const row = existing.find(
      (item) => item.childId === null && item.sourceRef === incoming.sourceRef,
    );
    if (row?.state === 'removed') return { action: 'skip', reason: 'tombstone' };
    if (row) return { action: 'update_progress' };
  }
  return { action: 'insert' };
}

export function progressLabel(input: {
  kind: StampKind;
  seasonLabel: string;
  weeksTotal: number | null;
  weeksElapsed: number;
  sessionStart: string | null;
  completed: boolean;
  now: Date;
}): string | null {
  if (input.kind === 'outing') return null;
  if (input.completed) return `${input.seasonLabel} · complete`;
  if (
    input.weeksTotal === null ||
    input.weeksTotal < 2 ||
    input.weeksElapsed <= 0 ||
    (input.sessionStart !== null && isoOf(input.now) < input.sessionStart)
  ) {
    return input.seasonLabel;
  }
  return `${input.seasonLabel} · ${input.weeksElapsed} of ${input.weeksTotal} weeks`;
}

export function stampFaceDate(iso: string): string {
  const month = Number(iso.slice(5, 7));
  const year = iso.slice(2, 4);
  const label = FACE_MONTHS[month - 1];
  if (!label || !year) return '';
  return `${label} ${year}`;
}

export function groupVisible(
  stamp: { shared: boolean; state: StampState },
  familyShare: boolean,
): boolean {
  if (stamp.state === 'removed') return false;
  if (stamp.shared) return stamp.state === 'confirmed' || stamp.state === 'inferred';
  return familyShare && stamp.state === 'confirmed';
}

export interface GroupProjection {
  childFirstName: string;
  activity: string;
  season: string;
}

export function projectForGroup(
  stamp: { shared: boolean; state: StampState; activity: string; seasonLabel: string },
  childFirstName: string,
  familyShare: boolean,
): GroupProjection | null {
  if (!groupVisible(stamp, familyShare)) return null;
  const first = childFirstName.trim().split(/\s+/)[0];
  if (!first) return null;
  return { childFirstName: first, activity: stamp.activity, season: stamp.seasonLabel };
}

export function sourceLabel(input: {
  sourceType: SourceType;
  viewerIsOwner: boolean;
  ownerFirstName: string | null;
  sharerFirstName: string | null;
  toldOn: string | null;
}): string {
  if (input.sourceType === 'gmail') {
    if (input.viewerIsOwner) return 'Seen in your Gmail receipt';
    const first = input.ownerFirstName?.trim().split(/\s+/)[0];
    return first ? `Seen in ${first}'s Gmail receipt` : 'Seen in a Gmail receipt';
  }
  if (input.sourceType === 'calendar') return 'Weekly Calendar event';
  if (input.sourceType === 'parent') {
    return glueMonthDay(input.toldOn ? `You told Hale · ${input.toldOn}` : 'You told Hale');
  }
  const sharer = input.sharerFirstName?.trim().split(/\s+/)[0];
  return sharer ? `Shared by ${sharer}'s family (opted in)` : 'Shared by a family (opted in)';
}

export const UNDO_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function canUndo(removedAt: Date | null, now: Date): boolean {
  if (!removedAt) return false;
  const age = now.getTime() - removedAt.getTime();
  return age >= 0 && age <= UNDO_WINDOW_MS;
}

export function nextStepOffer(input: {
  alreadyOffered: boolean;
  sessionEnding: boolean;
  forbiddenActivityKeys: readonly string[];
}): { mode: 'next_season' | 'adjacent'; forbiddenActivityKeys: readonly string[] } | null {
  if (input.alreadyOffered) return null;
  return {
    mode: input.sessionEnding ? 'next_season' : 'adjacent',
    forbiddenActivityKeys: input.forbiddenActivityKeys,
  };
}

export function sessionEnding(input: {
  completed: boolean;
  sessionEnd: string | null;
  weeksTotal: number | null;
  weeksElapsed: number;
  now: Date;
}): boolean {
  if (input.completed) return true;
  if (
    input.weeksTotal !== null &&
    input.weeksTotal >= 2 &&
    input.weeksElapsed >= input.weeksTotal - 1
  ) {
    return true;
  }
  if (!input.sessionEnd) return false;
  const days =
    (Date.parse(`${input.sessionEnd}T00:00:00Z`) - Date.parse(`${isoOf(input.now)}T00:00:00Z`)) /
    86_400_000;
  return days <= 14;
}

export function appendPassportLine(
  body: string,
  line: string | null,
  alreadySending: boolean,
):
  | { body: string; included: true }
  | { body: string; included: false; skipped: 'no_outbound' | 'copy_unavailable' } {
  if (!alreadySending || body.trim() === '') {
    return { body, included: false, skipped: 'no_outbound' };
  }
  if (!line) return { body, included: false, skipped: 'copy_unavailable' };
  return { body: `${body}\n\n${line}`, included: true };
}
