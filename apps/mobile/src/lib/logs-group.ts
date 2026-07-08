import type { LogView } from './api-types';

/** A day section of the grouped glance-detail list: a human day heading + its rows
 * in order (mirrors the web LogDayGroup, day-grained). */
export interface LogDayGroup {
  dayKey: string;
  label: string;
  logs: LogView[];
}

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Today" / "Yesterday" / "Mon, Jul 6" — a day heading for the grouped list. Local
 * days: on-device the parent's local day IS the family's day. */
export function dayHeading(dayKey: string, now: Date = new Date()): string {
  if (dayKey === localDayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKey === localDayKey(yesterday)) return 'Yesterday';
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Buckets a flat, newest-first page of logs into day sections (newest day first,
 * within-day order preserved), each with a human heading. Pure — mirrors the web
 * groupLogsByDay. An empty page yields no sections (the caller shows the calm empty
 * state, never a fabricated day).
 */
export function groupLogsByDay(logs: LogView[], now: Date = new Date()): LogDayGroup[] {
  const groups: LogDayGroup[] = [];
  let current: LogDayGroup | null = null;
  for (const log of logs) {
    const key = localDayKey(new Date(log.occurredAt));
    if (!current || current.dayKey !== key) {
      current = { dayKey: key, label: dayHeading(key, now), logs: [] };
      groups.push(current);
    }
    current.logs.push(log);
  }
  return groups;
}
