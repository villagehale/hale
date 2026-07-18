/**
 * Pure builder for the native quick-log sheet (QuickLogModal): turns the sheet's
 * per-kind selections into the exact wire body the /api/mobile/companion/log route
 * expects. Split out of the component (like measurement-compose.ts) so the payload
 * shape is unit-testable against the server contract without a native runtime.
 *
 * The server feed/diaper/nap/milestone contracts live in apps/web log-types
 * (quickLogSchema); the native bundle can't import them, so the kind literals + the
 * chip→field mappings are replicated here (same discipline as quick-log-detect.ts /
 * api-types.ts). See task-9-report for the feed chip → amountMl/feedKind mapping and
 * its tradeoff.
 */

export type LogKind = 'feed' | 'nap' | 'diaper' | 'milestone';

/** The feed / diaper kind literals the server accepts. */
export type FeedKindValue = 'bottle' | 'breast' | 'solid';
export type DiaperKindValue = 'wet' | 'dirty' | 'mixed' | 'dry';

export const SHEET_TITLE: Record<LogKind, string> = {
  feed: 'Log feed',
  nap: 'Log nap',
  diaper: 'Log diaper',
  milestone: 'Milestone',
};

/** The prototype's "What did {child} have?" chips → the server feedKind. The server
 * has three kinds (bottle/breast/solid); the six chips fold onto them where they map
 * and carry no feedKind where they don't (Water / Other). */
export const FEED_WHAT: { label: string; feedKind: FeedKindValue | null }[] = [
  { label: 'Milk', feedKind: 'bottle' },
  { label: 'Solid food', feedKind: 'solid' },
  { label: 'Snack', feedKind: 'solid' },
  { label: 'Water', feedKind: null },
  { label: 'Breastmilk', feedKind: 'breast' },
  { label: 'Other', feedKind: null },
];

/** The prototype's qualitative "How much" chips → a representative amountMl. The
 * server feed contract requires a positive amountMl (it has no qualitative field), so
 * a nominal volume stands in for the qualitative pick. These are NOT measured
 * amounts. */
export const FEED_AMOUNT: { label: string; amountMl: number }[] = [
  { label: 'A little', amountMl: 30 },
  { label: 'Half', amountMl: 90 },
  { label: 'Most of it', amountMl: 150 },
  { label: 'All of it', amountMl: 210 },
];

/** The prototype's nap "Quality" chips. The nap contract has no quality field, so the
 * pick is folded into the note ("Quality: Good"). */
export const NAP_QUALITY = ['Poor', 'Okay', 'Good', 'Excellent'] as const;

/** The prototype's diaper "What kind?" chips → the server diaperKind. */
export const DIAPER_KIND: { label: string; value: DiaperKindValue }[] = [
  { label: 'Wet', value: 'wet' },
  { label: 'Dirty', value: 'dirty' },
  { label: 'Mixed', value: 'mixed' },
  { label: 'Dry', value: 'dry' },
];

export function feedKindForLabel(label: string): FeedKindValue | null {
  return FEED_WHAT.find((w) => w.label === label)?.feedKind ?? null;
}

export function amountMlForLabel(label: string): number | undefined {
  return FEED_AMOUNT.find((a) => a.label === label)?.amountMl;
}

/**
 * Shapes the POST body for the tapped kind. A feed carries the representative
 * amountMl + optional feedKind from its chips; a nap sends its start/end WINDOW (the
 * server derives the duration) with the quality folded into the note; a diaper sends
 * its diaperKind; a milestone sends its text. An optional parent note rides on feed
 * and diaper. The caller has already resolved `occurredAt` (a nap uses its window
 * end; every other kind uses the picked "when").
 */
export function buildLogPayload(input: {
  kind: LogKind;
  childId: string;
  occurredAt: string;
  feedWhat: string;
  feedAmount: string;
  napQuality: string;
  napStartAt: string | null;
  napEndAt: string | null;
  diaperKind: DiaperKindValue;
  milestone: string;
  note: string;
}): Record<string, unknown> {
  const { kind, childId, occurredAt } = input;
  const base: Record<string, unknown> = { kind, childId, occurredAt };
  const trimmedNote = input.note.trim();

  if (kind === 'feed') {
    const feedKind = feedKindForLabel(input.feedWhat);
    return {
      ...base,
      amountMl: amountMlForLabel(input.feedAmount),
      ...(feedKind ? { feedKind } : {}),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    };
  }
  if (kind === 'nap') {
    return {
      ...base,
      startAt: input.napStartAt ?? undefined,
      endAt: input.napEndAt ?? undefined,
      note: `Quality: ${input.napQuality}`,
    };
  }
  if (kind === 'diaper') {
    return {
      ...base,
      diaperKind: input.diaperKind,
      ...(trimmedNote ? { note: trimmedNote } : {}),
    };
  }
  return { ...base, milestone: input.milestone.trim() };
}
