import { askPolicyTiersEnabled } from '@hale/worker/autonomy-gate';
import type { CalendarInviteParentOutcome, CalendarInviteSender } from '@hale/worker/executor';
import type { OpsPager } from '~/lib/monitoring/failure-page';

/**
 * VIL-719 · the text each parent gets after a calendar placement is the tell-after for a
 * calendar change (a tell-after action under the ask policy). When it could not be written,
 * nothing was sent (`compose_deferred`) and, while ASK_POLICY_TIERS_ENABLED is on for the
 * family, #ops is told. A decorator on the invite port: the report comes back untouched, so
 * nothing here can change a placement or its invite.
 *
 * Pages for every deferral where the writer produced no sendable text: no client, no skill,
 * a failed call, every draft refused (`gate_exhausted`), or the time unjudged. The time
 * judge's failure and an unreadable zone share `time_unjudged` on the leg, and a missed
 * model failure costs more than a rare page for a bad zone. A summary that is too long or
 * carries a destination is held by design before any model call, and does not page.
 */

const WRITER_FAILURES = [
  'client_unavailable',
  'skill_unavailable',
  'model_failed',
  'gate_exhausted',
  'time_unjudged',
] as const;
type WriterFailure = (typeof WRITER_FAILURES)[number];

function writerFailure(parent: CalendarInviteParentOutcome): WriterFailure | null {
  if (parent.outcome !== 'compose_deferred') return null;
  return WRITER_FAILURES.find((reason) => reason === parent.reason) ?? null;
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
      const reason = report.parents.map(writerFailure).find((found) => found !== null);
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
