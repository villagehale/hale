/**
 * The pure decision logic behind the Ask DRAFT-LOG card (quick-log-card.tsx): does a
 * drafted quick-log still need a datum from the parent before it can be approved, and
 * what wire body does it POST once resolved. Split out (like approval-gate.ts) so the
 * "honest amount" contract is unit-tested without a native renderer.
 *
 * The whole point (the no-fabrication rule): a draft NEVER writes a value the parent
 * didn't give. Each kind has exactly ONE datum the server requires, and the card
 * withholds Approve until it's present — either lifted by the detector or picked in
 * the card. Mirrors the server boundaries exactly:
 *   feed      → resolveFeed:  amountMl OR feedAmount (log-write.ts)
 *   nap       → resolveNap:   durationMin OR a start/end window (log-write.ts)
 *   diaper    → diaperSchema: diaperKind required, z.enum (log-types.ts)
 *   milestone → milestoneSchema: milestone z.string().min(1) (log-types.ts)
 * The free-text draft path only carries the direct field (no nap window), so a nap
 * needs a durationMin.
 */

import type { QuickLogMatch } from './quick-log-detect';
import type { DiaperKindValue, FeedAmountValue } from './quick-log-payload';

/** The parent's in-card picks for the fields the detector didn't lift — each stays
 * null / empty until the parent sets it. */
export interface DraftPicks {
  feedAmount: FeedAmountValue | null;
  durationMin: number | null;
  diaperKind: DiaperKindValue | null;
  milestone: string;
}

export const EMPTY_PICKS: DraftPicks = {
  feedAmount: null,
  durationMin: null,
  diaperKind: null,
  milestone: '',
};

/**
 * True while the draft still lacks the one datum its kind requires server-side, so
 * Approve must stay disabled and the card shows the picker. A datum counts as present
 * when the detector lifted it OR the parent picked it — never a fabricated default.
 */
export function draftNeedsInput(match: QuickLogMatch, picks: DraftPicks): boolean {
  if (match.kind === 'feed') {
    return match.amountMl === undefined && match.feedAmount === undefined && picks.feedAmount === null;
  }
  if (match.kind === 'nap') {
    return match.durationMin === undefined && picks.durationMin === null;
  }
  if (match.kind === 'diaper') {
    return match.diaperKind === undefined && picks.diaperKind === null;
  }
  return match.milestone === undefined && picks.milestone.trim() === '';
}

/**
 * The POST body for the drafted match — the parent's ACTUAL values (detector-lifted
 * or picked), NEVER a fabricated default. Intended to be called only once
 * draftNeedsInput is false; if a required field is somehow still absent it is OMITTED
 * (the server rejects it) rather than invented, so an amount-less feed / durationless
 * nap / kindless diaper / textless milestone can never be silently written.
 */
export function buildDraftBody(
  match: QuickLogMatch,
  childId: string,
  occurredAt: string,
  picks: DraftPicks,
): Record<string, unknown> {
  const base = { childId, occurredAt };
  if (match.kind === 'feed') {
    if (match.amountMl !== undefined) return { kind: 'feed', ...base, amountMl: match.amountMl };
    const feedAmount = match.feedAmount ?? picks.feedAmount ?? undefined;
    return { kind: 'feed', ...base, ...(feedAmount ? { feedAmount } : {}) };
  }
  if (match.kind === 'nap') {
    const durationMin = match.durationMin ?? picks.durationMin ?? undefined;
    return { kind: 'nap', ...base, ...(durationMin !== undefined ? { durationMin } : {}) };
  }
  if (match.kind === 'diaper') {
    const diaperKind = match.diaperKind ?? picks.diaperKind ?? undefined;
    return { kind: 'diaper', ...base, ...(diaperKind ? { diaperKind } : {}) };
  }
  const milestone = (match.milestone ?? picks.milestone).trim();
  return { kind: 'milestone', ...base, ...(milestone ? { milestone } : {}) };
}
