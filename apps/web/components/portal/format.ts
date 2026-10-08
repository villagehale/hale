import type { PlanTier } from '@hale/types';

/** "9:30 PM" from a stored 'HH:MM:SS' quiet-hours value. */
export function clockLabel(value: string): string {
  const [hourText, minuteText] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  const date = new Date(Date.UTC(2020, 0, 1, hour, minute));
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(date);
}

/** The plan page's three names. The stored `family` tier is Max. */
export function planName(tier: PlanTier): 'Free' | 'Plus' | 'Max' {
  if (tier === 'plus') return 'Plus';
  if (tier === 'family') return 'Max';
  return 'Free';
}

export function shortDate(value: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

export function dayHeading(dayKey: string, todayKey: string, yesterdayKey: string): string {
  if (dayKey === todayKey) return 'Today';
  if (dayKey === yesterdayKey) return 'Yesterday';
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return dayKey;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}
