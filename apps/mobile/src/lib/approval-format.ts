/**
 * Pure presentation helpers for an approval (the reviewer verdict tag + a readable
 * action title), shared by the Approvals LIST and the approval DETAIL page so the
 * two never drift. No RN import — unit-testable off-device.
 */
import type { HistoryStatus } from './api-types';

export type VerdictTag = { label: string; tone: 'neutral' | 'done' | 'attention' | 'coach' };

const VERDICT_TAG: Record<string, VerdictTag> = {
  pending: { label: 'Reviewing', tone: 'coach' },
  approved: { label: 'Reviewer approved', tone: 'done' },
  rejected: { label: 'Reviewer flagged', tone: 'attention' },
  flagged: { label: 'Reviewer flagged', tone: 'attention' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function verdictTag(verdict: string): VerdictTag {
  return VERDICT_TAG[verdict] ?? { label: verdict.replace(/_/g, ' '), tone: 'neutral' };
}

/** De-snake a raw action_type into a readable title ("place_supply_order" →
 * "Place supply order") so a DB enum never surfaces as a heading. */
export function humanizeActionType(actionType: string): string {
  const s = actionType.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A resolved-action status → its History chip (label + tone). Distinct from the
 * live verdictTag: History shows the OUTCOME (done/declined/reverted/held), not the
 * reviewer's pre-decision verdict. */
const HISTORY_STATUS_TAG: Record<HistoryStatus, VerdictTag> = {
  executed: { label: 'Done', tone: 'done' },
  declined: { label: 'Declined', tone: 'neutral' },
  reverted: { label: 'Reverted', tone: 'attention' },
  held: { label: 'Held for you', tone: 'coach' },
  failed: { label: "Couldn't complete", tone: 'attention' },
};

export function historyStatusTag(status: HistoryStatus): VerdictTag {
  return HISTORY_STATUS_TAG[status];
}
