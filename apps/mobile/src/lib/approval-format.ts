/**
 * Pure presentation helpers for an approval (the reviewer verdict tag + a readable
 * action title), shared by the Approvals LIST and the approval DETAIL page so the
 * two never drift. No RN import — unit-testable off-device.
 */

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
