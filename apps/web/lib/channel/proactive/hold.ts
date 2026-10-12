import { dayKeyOf } from '~/lib/format/datetime';
import type { PriorDecision, SnapshotCandidate } from './snapshot';

/**
 * VIL-226 · which open candidates this hourly run may hand to the model.
 *
 * A hold with a clock time stays out until that time. A hold with no clock time is
 * looked at again only when something new arrived, or on a later local day. The skill
 * decides; this file only stops the model being called every hour for the same hold.
 *
 * A hold the code made after the decider chose `send_now` (a red line at send time:
 * consent, a paused line, no number, an unvoiced or undelivered text) keeps that
 * decision on the row. The day turning changes none of those, so it reopens only on
 * its clock (quiet hours carry their end) or when something new arrived.
 */

export interface OpenCandidate extends SnapshotCandidate {
  /** The composed text. The writer reads it; the decider never does. */
  what: string;
  status: 'queued' | 'held';
  /** The decider's last action on the row, or null before it chose one. */
  decision: string | null;
  holdUntil: string | null;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export function planHourlyReview(input: {
  items: readonly OpenCandidate[];
  now: Date;
  timeZone: string;
  /** A parent reply, a calendar change, or a Gmail change after the last hold. */
  externalSignal: boolean;
}): { skipModel: boolean; candidates: SnapshotCandidate[]; priorDecisions: PriorDecision[] } {
  const priorDecisions: PriorDecision[] = input.items
    .filter((item) => item.status === 'held')
    .map((item) => ({
      id: item.id,
      action: 'held',
      at: item.decidedAt,
      reason: item.reason,
      holdUntil: item.holdUntil,
    }));

  const waiting = input.items.filter(
    (item) =>
      item.status === 'held' &&
      item.holdUntil !== null &&
      Date.parse(item.holdUntil) > input.now.getTime(),
  );
  const due = input.items.filter((item) => !waiting.includes(item));
  const queued = due.filter((item) => item.status === 'queued');
  const heldExpired = due.filter((item) => item.status === 'held' && item.holdUntil !== null);
  const heldOpen = due.filter((item) => item.status === 'held' && item.holdUntil === null);
  const deciderHeld = heldOpen.filter((item) => item.decision !== 'send_now');
  const codeHeld = heldOpen.filter((item) => item.decision === 'send_now');

  const latest = deciderHeld
    .map((item) => item.decidedAt)
    .filter((at): at is string => typeof at === 'string')
    .sort()
    .at(-1);
  const sameDay =
    latest !== undefined &&
    dayKeyOf(latest, input.timeZone) === dayKeyOf(input.now, input.timeZone);
  const fresh = input.externalSignal || queued.length > 0;
  const reopen = !sameDay || fresh;

  const actionable = [
    ...queued,
    ...heldExpired,
    ...(reopen ? deciderHeld : []),
    ...(fresh ? codeHeld : []),
  ];
  return {
    skipModel: actionable.length === 0,
    candidates: actionable.map(asCandidate),
    priorDecisions,
  };
}

function asCandidate(item: OpenCandidate): SnapshotCandidate {
  return {
    id: item.id,
    kind: item.kind,
    why: item.why,
    sourceUrl: item.sourceUrl,
    worthlessAfter: item.worthlessAfter,
    parentRequested: item.parentRequested,
  };
}
