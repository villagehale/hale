import type { ClaimCandidateRow, ClaimCandidateSet, ClaimRowAlias } from './candidates';
import type { ClaimReadOutcome, ReadClaim } from './claim-reader';
import { dayTimeConflict } from './day-time';
import type { ClaimResolution, RefusalReason } from './reconcile';

/**
 * VIL-581 · code verifies every citation the reader made. Pure: the alias must be one
 * this call offered (the per-call map), the row's kind must be able to back the claim's
 * kind, and a booking cited to a calendar row must not name another day or time.
 * Refusals keep main's vocabulary (`RefusalReason`); `why` says which check refused.
 *
 * A refused claim is a VERDICT about a sentence. A failed read is a different union in
 * a different module (claim-reader.ts) and is never expressed as a refusal.
 */

export type UnbackedWhy =
  | 'cited_none'
  | 'alias_not_offered'
  | 'kind_incompatible'
  | 'day_time_conflict'
  | 'never_backable';

/** Main's regex matches, plus the rows only the reader can cite. */
type MatchedBy =
  | Extract<ClaimResolution, { status: 'matched' }>['matchedBy']
  | 'signup_confirmation'
  | 'booking_row'
  | 'parent_reported'
  | 'send_receipt'
  | 'cancellation_row';
type MintableWindow = Extract<ClaimCandidateRow, { source: 'mintable_window' }>;

export type ReadClaimResolution =
  | { claim: ReadClaim; status: 'backed'; alias: ClaimRowAlias; matchedBy: MatchedBy }
  | { claim: ReadClaim; status: 'minted'; alias: 'w1'; window: MintableWindow }
  | { claim: ReadClaim; status: 'refused'; reason: RefusalReason; why: UnbackedWhy };

export interface ClaimReadVerdict {
  resolutions: readonly ReadClaimResolution[];
  /** Ascending and unique: every segment holding ANY refused claim. */
  refusedSegments: readonly number[];
  mints: readonly MintableWindow[];
}

/** Which row can back which claim kind, and as what. Null: it cannot. */
function backing(kind: ReadClaim['kind'], row: ClaimCandidateRow): MatchedBy | 'minted' | null {
  switch (kind) {
    case 'scheduled_event':
      if (row.source === 'calendar') return 'scheduled_row';
      if (row.source === 'parent_stated') return 'parent_stated';
      if (row.source === 'booking') return 'booking_row';
      return null;
    // A calendar row is never a registration: it says the thing is planned, not that a
    // place was taken. Only a confirmation, a recorded booking or the parent's own word.
    case 'registration_done':
      if (row.source === 'signup_confirmed') return 'signup_confirmation';
      if (row.source === 'booking') return 'booking_row';
      if (row.source === 'reported_outcome') return 'parent_reported';
      if (row.source === 'parent_stated') return 'parent_stated';
      return null;
    case 'send_done':
      return row.source === 'send_receipt' ? 'send_receipt' : null;
    case 'cancelled':
      return row.source === 'cancelled' ? 'cancellation_row' : null;
    case 'registration_watch':
      if (row.source === 'open_commitment' && row.kind === 'registration_watch') {
        return 'open_commitment';
      }
      if (row.source === 'live_sequence') return 'live_sequence';
      if (row.source === 'mintable_window') return 'minted';
      return null;
    case 'spot_watch':
      if (row.source === 'watched_page') return 'open_commitment';
      if (row.source === 'pending' && row.kind === 'spot_watch') return 'pending_commitment';
      return null;
    case 'activity_followup':
      if (row.source === 'open_commitment' && row.kind === 'activity_followup') {
        return 'open_commitment';
      }
      if (row.source === 'pending' && row.kind === 'activity_followup') {
        return 'pending_commitment';
      }
      return null;
    case 'co_parent_invite':
    case 'self_referential':
      return null;
  }
}

function hasSpotWatch(candidates: ClaimCandidateSet): boolean {
  for (const row of candidates.byAlias.values()) {
    if (row.kind === 'spot_watch') return true;
  }
  return false;
}

/** The reason an unbacked claim of this kind is refused (main's mapping, rev 2). */
function refusalFor(kind: ReadClaim['kind'], candidates: ClaimCandidateSet): RefusalReason {
  switch (kind) {
    case 'registration_watch':
      return 'no_registration_watch';
    case 'spot_watch':
      return hasSpotWatch(candidates) ? 'spot_watch_unshaped' : 'no_registration_watch';
    case 'scheduled_event':
      return 'no_scheduled_row';
    case 'activity_followup':
      return 'no_activity_promise';
    case 'co_parent_invite':
      return 'no_coparent_invite';
    case 'self_referential':
      return 'self_referential';
    case 'registration_done':
      return 'no_registration_record';
    case 'send_done':
      return 'no_send_record';
    case 'cancelled':
      return 'no_cancel_record';
  }
}

function resolve(
  claim: ReadClaim,
  sentence: string,
  ctx: { candidates: ClaimCandidateSet; locale: string | undefined; timeZone: string },
): ReadClaimResolution {
  const refused = (why: UnbackedWhy): ReadClaimResolution => ({
    claim,
    status: 'refused',
    reason: refusalFor(claim.kind, ctx.candidates),
    why,
  });
  if (claim.kind === 'co_parent_invite' || claim.kind === 'self_referential') {
    return refused('never_backable');
  }
  if (claim.row === 'none') return refused('cited_none');
  const row = ctx.candidates.byAlias.get(claim.row);
  if (!row) return refused('alias_not_offered');
  const by = backing(claim.kind, row);
  if (by === null) return refused('kind_incompatible');
  if (by === 'minted') {
    return { claim, status: 'minted', alias: 'w1', window: row as MintableWindow };
  }
  if (
    row.source === 'calendar' &&
    dayTimeConflict(sentence, row.startsAt, ctx.timeZone, ctx.locale)
  ) {
    return refused('day_time_conflict');
  }
  return { claim, status: 'backed', alias: claim.row, matchedBy: by };
}

export function verifyClaimRead(
  read: Extract<ClaimReadOutcome, { status: 'read' }>,
  ctx: { candidates: ClaimCandidateSet; locale: string | undefined; timeZone: string },
): ClaimReadVerdict {
  const resolutions = read.claims.map((claim) => {
    // acceptClaimRead already bounded every index; an unknown one here is a bug.
    const segment = read.segments[claim.segment];
    if (!segment)
      throw new RangeError('claim verdict: a claim cites a segment that does not exist');
    return resolve(claim, segment.text, ctx);
  });
  const refusedSegments = [
    ...new Set(resolutions.filter((r) => r.status === 'refused').map((r) => r.claim.segment)),
  ].sort((a, b) => a - b);
  const mints = [...new Set(resolutions.flatMap((r) => (r.status === 'minted' ? [r.window] : [])))];
  return { resolutions, refusedSegments, mints };
}
