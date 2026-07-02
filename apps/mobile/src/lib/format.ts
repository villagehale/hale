import type { MilestoneStatus } from './api-types';

/** "3 mo" under two years, "2 yr" beyond — the compact companion age label. */
export function agePhrase(ageMonths: number): string {
  if (ageMonths < 24) return `${ageMonths} mo`;
  return `${Math.floor(ageMonths / 12)} yr`;
}

/** Whole-weeks-until a health item → a calm human phrase (mirrors the web page). */
export function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'in 1 week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** Milestone timing → the parent-facing label (mirrors the web page). */
export const MILESTONE_TIMING_LABEL: Record<MilestoneStatus['timing'], string> = {
  upcoming: 'coming up',
  in_window: 'around now',
  watch: 'worth asking',
};

/** A logged episode's ISO time → a short "Jul 2, 2:15pm" style phrase. */
export function whenPhrase(occurredAt: string): string {
  return new Date(occurredAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
