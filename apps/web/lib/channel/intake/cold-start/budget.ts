/**
 * VIL-392 — one optional-ask budget, shared with the duty_ask send class.
 *
 * During the first seven days after the family starts: at most four optional
 * asks, and at most one per family-local calendar day. A duty ask counts.
 * A declined ask is final. Two declined or unanswered asks in a row pause
 * every discretionary ask until the parent writes again. Silence past 24h is
 * unanswered. The stop-asking fact blocks everything until it expires.
 */

export const SHARED_STOP_ASKING_KEY = 'duty-ask/stop-asking';
export const ASK_UNANSWERED_MS = 24 * 60 * 60 * 1000;
export const ASK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const ASK_WINDOW_MAX = 4;

export const OPTIONAL_ASK_CLASSES = [
  'duty_ask',
  'logistics',
  'names',
  'calendar',
  'email',
] as const;
export type OptionalAskClass = (typeof OPTIONAL_ASK_CLASSES)[number];

export interface AskLedgerRow {
  sendClass: OptionalAskClass;
  askKey: string;
  outcome: 'sent' | 'declined';
  localDay: string;
  createdAt: Date;
}

export interface AskBudgetInput {
  now: Date;
  familyStartedAt: Date;
  rows: readonly AskLedgerRow[];
  stopUntil: Date | null;
  /** True when a later parent text has already lifted a two-ask pause. */
  parentWroteSincePause: boolean;
  timeZone?: string;
}

export type AskBudgetBlock = 'ask_budget' | 'declined' | 'paused' | 'stop_asking' | 'already_asked';

export type AskBudgetVerdict = { allow: true } | { allow: false; reason: AskBudgetBlock };

export function localCalendarDay(now: Date, timeZone = 'America/Toronto'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function inAskWindow(now: Date, familyStartedAt: Date): boolean {
  return now.getTime() <= familyStartedAt.getTime() + ASK_WINDOW_MS;
}

/** The newer of two consecutive bad asks, or null when the pause is not on. */
export function pauseAnchor(rows: readonly AskLedgerRow[], now: Date): Date | null {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  let streak = 0;
  let newer: Date | null = null;
  for (const row of sorted) {
    if (isPending(row, now)) break;
    if (!isBad(row, now)) break;
    streak += 1;
    if (streak === 1) newer = row.createdAt;
    if (streak >= 2) return newer;
  }
  return null;
}

export function judgeAskBudget(
  input: AskBudgetInput,
  ask: { sendClass: OptionalAskClass; askKey: string },
): AskBudgetVerdict {
  if (input.stopUntil && input.stopUntil.getTime() > input.now.getTime()) {
    return { allow: false, reason: 'stop_asking' };
  }
  const same = input.rows.filter((row) => row.askKey === ask.askKey);
  if (same.some((row) => row.outcome === 'declined')) return { allow: false, reason: 'declined' };
  if (same.length > 0) return { allow: false, reason: 'already_asked' };
  if (pauseAnchor(input.rows, input.now) && !input.parentWroteSincePause) {
    return { allow: false, reason: 'paused' };
  }
  if (inAskWindow(input.now, input.familyStartedAt)) {
    const day = localCalendarDay(input.now, input.timeZone);
    if (input.rows.some((row) => row.localDay === day))
      return { allow: false, reason: 'ask_budget' };
    if (input.rows.length >= ASK_WINDOW_MAX) return { allow: false, reason: 'ask_budget' };
  }
  return { allow: true };
}

function isPending(row: AskLedgerRow, now: Date): boolean {
  return row.outcome === 'sent' && now.getTime() - row.createdAt.getTime() <= ASK_UNANSWERED_MS;
}

function isBad(row: AskLedgerRow, now: Date): boolean {
  if (row.outcome === 'declined') return true;
  return row.outcome === 'sent' && now.getTime() - row.createdAt.getTime() > ASK_UNANSWERED_MS;
}
