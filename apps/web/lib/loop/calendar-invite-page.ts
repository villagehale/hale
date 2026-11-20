import { askPolicyTiersEnabled } from '@hale/worker/autonomy-gate';
import type { CalendarInviteParentOutcome, CalendarInviteSender } from '@hale/worker/executor';
import type { OpsPager } from '~/lib/monitoring/failure-page';

/**
 * VIL-719 · the text each parent gets after a calendar placement is the tell-after for a
 * calendar change (a tell-after action under the ask policy). When the model could not
 * write it, nothing was sent (`compose_deferred`) and, while ASK_POLICY_TIERS_ENABLED is on
 * for the family, #ops is told. A decorator on the executor's invite port: the report comes
 * back untouched, so nothing here can change a placement or its invite.
 *
 * Only the deferrals that mean the model could not write the words page. A deferral for
 * bad data (an unreadable zone, a summary that is too long or carries a place) is a fact
 * about the event, not a writer failure, and is already named on the leg.
 */

const MODEL_FAILURES = ['client_unavailable', 'skill_unavailable', 'model_failed'] as const;
type ModelFailure = (typeof MODEL_FAILURES)[number];

function modelFailure(parent: CalendarInviteParentOutcome): ModelFailure | null {
  if (parent.outcome !== 'compose_deferred') return null;
  return MODEL_FAILURES.find((reason) => reason === parent.reason) ?? null;
}

export function withInviteUnwrittenPage(
  inner: CalendarInviteSender,
  pager: OpsPager,
): CalendarInviteSender {
  return {
    async send(request) {
      const report = await inner.send(request);
      if (report.status !== 'reported') return report;
      if (!askPolicyTiersEnabled(request.familyId)) return report;
      const reason = report.parents.map(modelFailure).find((found) => found !== null);
      if (!reason) return report;
      const page = await pager.page({
        site: 'calendar_invite_unwritten',
        facts: { method: request.method, reason },
        ref: request.familyEventId,
      });
      console.warn(
        { familyId: request.familyId, method: request.method, reason, page },
        'calendar invite: text unwritten after a placement',
      );
      return report;
    },
  };
}
