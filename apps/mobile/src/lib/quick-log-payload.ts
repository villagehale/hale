/**
 * Pure builder for the native quick-log sheet (QuickLogModal): turns the sheet's
 * per-kind selections into the exact wire body the /api/mobile/companion/log route
 * expects. Split out of the component (like measurement-compose.ts) so the payload
 * shape is unit-testable against the server contract without a native runtime.
 *
 * The server feed/diaper/nap/milestone contracts live in apps/web log-types
 * (quickLogSchema); the native bundle can't import them, so the kind literals + the
 * chip→field mappings are replicated here (same discipline as quick-log-detect.ts /
 * api-types.ts). The feed sheet stores the QUALITATIVE amount the parent tapped
 * (feedAmount: little/half/most/all) — no invented millilitre figure.
 */

export type LogKind = 'feed' | 'nap' | 'diaper' | 'milestone';

/** The feed-kind / feed-amount / diaper-kind literals the server accepts. */
export type FeedKindValue = 'bottle' | 'breast' | 'solid';
export type FeedAmountValue = 'little' | 'half' | 'most' | 'all';
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

/** The prototype's qualitative "How much" chips → the server feedAmount enum. Stored
 * verbatim — the parent's own observation, no invented millilitre figure. */
export const FEED_AMOUNT: { label: string; value: FeedAmountValue }[] = [
  { label: 'A little', value: 'little' },
  { label: 'Half', value: 'half' },
  { label: 'Most of it', value: 'most' },
  { label: 'All of it', value: 'all' },
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

export function feedAmountForLabel(label: string): FeedAmountValue | undefined {
  return FEED_AMOUNT.find((a) => a.label === label)?.value;
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
  /** The direct minutes entry (the RN-web nap path, where the native time pickers
   * aren't available); null when the start/end window is used instead. */
  napDurationMin: number | null;
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
      feedAmount: feedAmountForLabel(input.feedAmount),
      ...(feedKind ? { feedKind } : {}),
      ...(trimmedNote ? { note: trimmedNote } : {}),
    };
  }
  if (kind === 'nap') {
    // A start/end window (native) drives the duration server-side; a direct minutes
    // entry (RN-web) sends durationMin. The quality rides in the note either way.
    const window =
      input.napStartAt && input.napEndAt
        ? { startAt: input.napStartAt, endAt: input.napEndAt }
        : { durationMin: input.napDurationMin ?? undefined };
    return { ...base, ...window, note: `Quality: ${input.napQuality}` };
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
