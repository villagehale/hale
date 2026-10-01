import type { DutyRole } from './model';

/**
 * VIL-382 · when a duty ask may be spoken, and into which bubble.
 *
 * The Sunday overview is the primary mode and only rides a bubble that is
 * already leaving. A 48-hour re-ask does the same: one re-ask, never its own
 * bubble. The night-before confirmation may open one bubble, and only inside
 * 17:00–21:00 local, which ends where quiet hours begin. A parent who asks
 * "who's got pickup Thursday?" is answered in the group. One open question
 * per group. After three unanswered asks, stop.
 *
 * Caps here are the group bubble budget: two proactive bubbles a day, and
 * one discretionary bubble a day / three a week. Quiet hours are decided by
 * the caller with the outbound gate's window so this file does not grow a
 * second clock.
 */

export const REASK_WITHIN_MS = 48 * 60 * 60 * 1000;
export const UNANSWERED_STEP_DOWN = 3;
export const NIGHT_BEFORE_START_MIN = 17 * 60;
export const DUTY_LLM_DAY_MAX = 1;

/** Matches family-outbound's group ceiling. A test pins the two together. */
export const PROACTIVE_BUBBLES_PER_DAY = 2;
export const DISCRETIONARY_PER_DAY = 1;
export const DISCRETIONARY_PER_WEEK = 3;

export type DutyAskMode =
  | 'week_overview'
  | 'reask_48h'
  | 'night_before'
  | 'parent_initiated'
  | 'which_kid'
  | 'both_claimed'
  | 'silent_parent';

export interface DutyOccasion {
  eventKey: string;
  role: DutyRole;
  startsAt: Date;
  hasOwner: boolean;
  conflict: boolean;
  needsWhichKid: boolean;
  cancelled: boolean;
  hasDutyRecord: boolean;
  /** The one re-ask for this event and role has already gone out. */
  reasked: boolean;
  source: 'calendar' | 'email';
  /** Name a parent said. Null unless someone claimed a single owner. */
  spokenName?: string | null;
  /** First name of the only parent whose calendar holds this event. */
  soloCalendarName?: string | null;
  kid?: string | null;
  eventLabel?: string | null;
  /** First names of parents who each said they have it, in claim order. */
  claimantNames?: readonly string[];
  /** User ids that have already answered this duty. */
  spokenUserIds?: readonly string[];
  childFirstNames?: readonly string[];
}

export interface OpenDutyQuestion {
  eventKey: string;
  role: DutyRole;
  unanswered: number;
  silentNamed: boolean;
  status: 'open' | 'stepped_down';
}

export interface CadenceContext {
  now: Date;
  bubbleLeaving: boolean;
  open: OpenDutyQuestion | null;
  occasions: readonly DutyOccasion[];
  /** Set when a parent just asked. Null when this is the sweep. */
  parentAsk: { role: DutyRole | null; weekday: number | null } | null;
  proactiveToday: number;
  discretionaryToday: number;
  discretionaryWeek: number;
  /** Minutes since local midnight. */
  localMinutes: number;
  /** 0 = Sunday … 6 = Saturday, in the parent's zone. */
  weekday: number;
  quiet: boolean;
  /** Quiet hours begin at this minute. The night-before window ends there. */
  quietStartMin: number;
  /**
   * A parent said "stop asking" inside the last 30 days. Items that ask
   * (which kid, both claimed, the 48-hour re-ask, night-before, silent parent)
   * stay quiet. The Sunday overview and a direct answer still leave.
   */
  stopAsking?: boolean;
  timeZone: string;
}

export interface CadenceLine {
  mode: DutyAskMode;
  eventKey: string | null;
  role: DutyRole | null;
  opensQuestion: boolean;
  namesSilentParent: boolean;
  discretionary: boolean;
}

export interface CadencePlan {
  /** Lines for a bubble that is already leaving. They are not a second send. */
  foldLines: CadenceLine[];
  /** Lines for the one bubble this tick may open. Empty when nothing sends. */
  sendLines: CadenceLine[];
  stepDown: { eventKey: string; role: DutyRole } | null;
  /** Cancelled events whose recorded duty must be closed. No text. */
  invalidateEventKeys: string[];
  held: 'quiet_hours' | 'group_cap' | 'open_question' | null;
}

const DAY_NAMES: ReadonlyArray<readonly [string, number]> = [
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6],
  ['dimanche', 0],
  ['lundi', 1],
  ['mardi', 2],
  ['mercredi', 3],
  ['jeudi', 4],
  ['vendredi', 5],
  ['samedi', 6],
];

export function localYmd(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addCalendarDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function isLocalTomorrow(now: Date, startsAt: Date, timeZone: string): boolean {
  return localYmd(startsAt, timeZone) === addCalendarDays(localYmd(now, timeZone), 1);
}

export function eventWithinMs(now: Date, startsAt: Date, windowMs: number): boolean {
  const delta = startsAt.getTime() - now.getTime();
  return delta > 0 && delta <= windowMs;
}

/** 17:00 inclusive, quiet-start exclusive. 21:00 is quiet, not a confirmation. */
export function inNightBeforeWindow(minutes: number, quietStartMin: number): boolean {
  return minutes >= NIGHT_BEFORE_START_MIN && minutes < quietStartMin;
}

export function dutySendHeldByCaps(input: {
  discretionary: boolean;
  proactiveToday: number;
  discretionaryToday: number;
  discretionaryWeek: number;
}): 'group_cap' | null {
  if (input.proactiveToday >= PROACTIVE_BUBBLES_PER_DAY) return 'group_cap';
  if (!input.discretionary) return null;
  if (input.discretionaryToday >= DISCRETIONARY_PER_DAY) return 'group_cap';
  if (input.discretionaryWeek >= DISCRETIONARY_PER_WEEK) return 'group_cap';
  return null;
}

/**
 * Rules only. The model is not called from here. A miss returns null and the
 * caller decides whether a budgeted extractor may run.
 */
export function matchParentDutyAsk(
  text: string,
): { role: DutyRole | null; weekday: number | null } | null {
  const normalized = text.trim().replace(/[’]/g, "'");
  if (!normalized) return null;
  const asks =
    /\b(?:who(?:'s| is| has) got|who has|who's on|who is on|qui a|qui s'occupe)\b/i.test(
      normalized,
    ) ||
    (normalized.includes('?') && /\b(pick[\s-]?ups?|drop[\s-]?offs?)\b/i.test(normalized));
  if (!asks) return null;
  let role: DutyRole | null = null;
  if (/\b(pick[\s-]?ups?|picking up)\b/i.test(normalized)) role = 'pickup';
  else if (/\b(drop[\s-]?offs?|dropping off)\b/i.test(normalized)) role = 'dropoff';
  else if (/\b(attend|attending)\b/i.test(normalized)) role = 'attend';
  let weekday: number | null = null;
  for (const [name, day] of DAY_NAMES) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(normalized)) weekday = day;
  }
  return { role, weekday };
}

/** Flag off, or the day's calls already spent: the extractor must not run. */
export function dutyExtractorMayRun(input: { sendsActive: boolean; callsToday: number }): boolean {
  return input.sendsActive && input.callsToday < DUTY_LLM_DAY_MAX;
}

function speakable(occasion: DutyOccasion): boolean {
  return !occasion.cancelled && occasion.source !== 'email';
}

function sameSlot(open: OpenDutyQuestion, occasion: DutyOccasion): boolean {
  return open.eventKey === occasion.eventKey && open.role === occasion.role;
}

function byStart(a: DutyOccasion, b: DutyOccasion): number {
  return a.startsAt.getTime() - b.startsAt.getTime();
}

/** which_kid, both_claimed, reask_48h, night_before. Overview, a direct answer, and the silent nudge do not. */
const ASK_BUDGET = new Set<DutyAskMode>(['which_kid', 'both_claimed', 'reask_48h', 'night_before']);

/** Suppressed for 30 days after "stop asking". Overview and parent_initiated stay. */
const STOP_ASKING_HOLDS = new Set<DutyAskMode>([
  'which_kid',
  'both_claimed',
  'reask_48h',
  'night_before',
  'silent_parent',
]);

export function dutyModeCountsAgainstAskBudget(mode: DutyAskMode): boolean {
  return ASK_BUDGET.has(mode);
}

function heldByStopAsking(ctx: CadenceContext, mode: DutyAskMode): boolean {
  return ctx.stopAsking === true && STOP_ASKING_HOLDS.has(mode);
}

function line(
  mode: DutyAskMode,
  occasion: DutyOccasion | null,
  extra: { opensQuestion: boolean; namesSilentParent?: boolean },
): CadenceLine {
  return {
    mode,
    eventKey: occasion?.eventKey ?? null,
    role: occasion?.role ?? null,
    opensQuestion: extra.opensQuestion,
    namesSilentParent: extra.namesSilentParent === true,
    discretionary: ASK_BUDGET.has(mode),
  };
}

function questionLine(occasion: DutyOccasion, ctx: CadenceContext): CadenceLine | null {
  if (occasion.needsWhichKid && !heldByStopAsking(ctx, 'which_kid')) {
    return line('which_kid', occasion, { opensQuestion: true });
  }
  if (occasion.conflict && !heldByStopAsking(ctx, 'both_claimed')) {
    return line('both_claimed', occasion, { opensQuestion: true });
  }
  if (
    !occasion.hasOwner &&
    !occasion.reasked &&
    !heldByStopAsking(ctx, 'reask_48h') &&
    eventWithinMs(ctx.now, occasion.startsAt, REASK_WITHIN_MS)
  ) {
    return line('reask_48h', occasion, { opensQuestion: true });
  }
  // Quiet hours still name the confirmation so the caller can hold it.
  // 21:00 is the end of the window and the start of quiet; a 21:30 tick must
  // not look like "nothing was due".
  if (
    occasion.hasOwner &&
    isLocalTomorrow(ctx.now, occasion.startsAt, ctx.timeZone) &&
    !heldByStopAsking(ctx, 'night_before') &&
    (inNightBeforeWindow(ctx.localMinutes, ctx.quietStartMin) || ctx.quiet)
  ) {
    return line('night_before', occasion, { opensQuestion: false });
  }
  return null;
}

function matchesParentAsk(
  occasion: DutyOccasion,
  ask: CadenceContext['parentAsk'],
  timeZone: string,
): boolean {
  if (!ask) return false;
  if (ask.role && ask.role !== occasion.role) return false;
  if (ask.weekday === null) return true;
  const ymd = localYmd(occasion.startsAt, timeZone);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === ask.weekday;
}

/**
 * One plan for this tick. Email-sourced rows are invalidated when cancelled
 * and never become a line. Two unowned events produce one question.
 */
export function planDutyCadence(ctx: CadenceContext): CadencePlan {
  const invalidateEventKeys = [
    ...new Set(
      ctx.occasions.filter((row) => row.cancelled && row.hasDutyRecord).map((row) => row.eventKey),
    ),
  ];
  const live = ctx.occasions.filter(speakable).slice().sort(byStart);
  const open = ctx.open;
  const stepped = open?.status === 'stepped_down';
  const stepDown =
    open && !stepped && open.unanswered >= UNANSWERED_STEP_DOWN
      ? { eventKey: open.eventKey, role: open.role }
      : null;

  let held: CadencePlan['held'] = null;
  let question: CadenceLine | null = null;

  if (ctx.parentAsk) {
    const match = live.find((row) => matchesParentAsk(row, ctx.parentAsk, ctx.timeZone)) ?? null;
    if (match) {
      const specific = questionLine(match, ctx);
      const opens = !match.hasOwner || match.needsWhichKid || match.conflict;
      if (opens && open && !stepped && !sameSlot(open, match)) {
        held = 'open_question';
      } else if (
        (specific?.mode === 'which_kid' || specific?.mode === 'both_claimed') &&
        !heldByStopAsking(ctx, specific.mode)
      ) {
        question = specific;
      } else if (match.hasOwner) {
        question = line('parent_initiated', match, { opensQuestion: false });
      } else if (!stepDown) {
        question = line('parent_initiated', match, { opensQuestion: true });
      }
    }
  } else if (!stepDown && !stepped) {
    const pool = open ? live.filter((row) => sameSlot(open, row)) : live;
    for (const occasion of pool) {
      const next = questionLine(occasion, ctx);
      if (!next) continue;
      if (next.opensQuestion && open && !sameSlot(open, occasion)) continue;
      question = next;
      break;
    }
    if (!question && !open) {
      const soonest = live.find((row) => !row.hasOwner || row.conflict || row.needsWhichKid);
      if (soonest && (soonest.needsWhichKid || soonest.conflict)) {
        question = questionLine(soonest, ctx);
      }
    }
  }

  const sundayOverview =
    ctx.weekday === 0 && ctx.bubbleLeaving && !ctx.quiet
      ? line('week_overview', null, { opensQuestion: false })
      : null;

  const foldLines: CadenceLine[] = [];
  const sendLines: CadenceLine[] = [];

  if (sundayOverview) foldLines.push(sundayOverview);

  if (question) {
    const foldable = question.mode !== 'parent_initiated' && question.mode !== 'night_before';
    if (ctx.bubbleLeaving && !ctx.quiet && foldable) {
      foldLines.push(question);
    } else if (
      !ctx.bubbleLeaving &&
      (question.mode === 'night_before' || question.mode === 'parent_initiated')
    ) {
      if (ctx.quiet) held = held ?? 'quiet_hours';
      else if (
        dutySendHeldByCaps({
          discretionary: question.discretionary,
          proactiveToday: ctx.proactiveToday,
          discretionaryToday: ctx.discretionaryToday,
          discretionaryWeek: ctx.discretionaryWeek,
        })
      ) {
        held = held ?? 'group_cap';
      } else {
        sendLines.push(question);
      }
    }
  }

  // A re-ask never opens a bubble. If a confirmation is already leaving, the
  // re-ask rides that one bubble — still the only open question.
  if (
    sendLines.length > 0 &&
    !question?.opensQuestion &&
    !stepDown &&
    !stepped &&
    !(open && open.unanswered >= UNANSWERED_STEP_DOWN)
  ) {
    const blocked = open && !stepped;
    const reask = live.find((row) => {
      if (blocked && !sameSlot(open, row)) return false;
      if (row.hasOwner || row.reasked || row.needsWhichKid || row.conflict) return false;
      return eventWithinMs(ctx.now, row.startsAt, REASK_WITHIN_MS);
    });
    if (
      reask &&
      !heldByStopAsking(ctx, 'reask_48h') &&
      !sendLines.some((row) => row.opensQuestion)
    ) {
      sendLines.push(line('reask_48h', reask, { opensQuestion: true }));
    }
  }

  const namingBubble = (ctx.bubbleLeaving && !ctx.quiet) || sendLines.length > 0;
  if (
    open &&
    !stepped &&
    !open.silentNamed &&
    !heldByStopAsking(ctx, 'silent_parent') &&
    open.unanswered >= 1 &&
    namingBubble &&
    !foldLines.some((row) => row.namesSilentParent) &&
    !sendLines.some((row) => row.namesSilentParent)
  ) {
    const silent = line('silent_parent', null, {
      opensQuestion: false,
      namesSilentParent: true,
    });
    silent.eventKey = open.eventKey;
    silent.role = open.role;
    if (sendLines.length > 0) sendLines.push(silent);
    else foldLines.push(silent);
  }

  const questions = [...foldLines, ...sendLines].filter((row) => row.opensQuestion);
  if (questions.length > 1) {
    const keep = questions[0];
    for (const list of [foldLines, sendLines]) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const row = list[i];
        if (row?.opensQuestion && row !== keep) list.splice(i, 1);
      }
    }
  }

  return { foldLines, sendLines, stepDown, invalidateEventKeys, held };
}
