import { ApproveButton } from '~/components/hale/approve-button';
import { DismissButton } from '~/components/hale/dismiss-button';
import { PageCorner } from '~/components/hale/page-corner';
import { ToneLabel } from '~/components/hale/tone';
import { loadPendingApprovals } from '~/lib/dashboard/queries';

/**
 * The Approvals surface — the parent-facing queue of drafts the inbound pipeline
 * produced and held for approval (rule #4: an L1/L2 family's drafts never execute
 * on their own). Each row shows the action type + a human preview of what the
 * draft does; the raw drafted payload is redacted for a 13+ child (rule #1, via
 * the approvals mapper). Approving a row posts to the approve route (enqueues
 * actions.approved); dismissing posts to the decline route — the "no" the consent
 * queue requires, which records its own audit_log row (rule #6).
 */
const NEEDS_YOU_VERDICTS = new Set(['flagged', 'rejected']);

export default async function ApprovalsPage() {
  const approvals = await loadPendingApprovals();

  return (
    <div>
      <PageCorner folio="approvals" section="approvals · awaiting you" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">approvals</span>
            <p className="meta mt-2">Hale drafts — you decide</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              waiting for your <span className="text-apricot-deep">yes</span>.
            </h1>
          </div>
        </div>
      </header>

      {approvals.length === 0 ? (
        <section className="rise rise-4 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing waiting on you.
          </p>
          <p className="meta mt-4 text-slate-green">
            when a signal comes in, Hale drafts a response and parks it here for
            your approval — it never acts on its own.
          </p>
        </section>
      ) : (
        <ul className="rise rise-2 border-t border-rule">
          {approvals.map((approval) => (
            <li
              key={approval.id}
              className="py-7 border-b border-rule flex flex-wrap items-start justify-between gap-y-4 gap-x-8"
            >
              <div className="min-w-0">
                <span className="eyebrow">{approval.actionType.replaceAll('_', ' ')}</span>
                <p className="font-display text-[1.25rem] mt-1 text-spruce">{approval.preview}</p>
                {NEEDS_YOU_VERDICTS.has(approval.verdict) ? (
                  <p className="mt-2">
                    <ToneLabel tone="needs-you" detail={approval.summary} />
                  </p>
                ) : (
                  <p className="meta mt-2 text-slate-green">{approval.summary}</p>
                )}
                <p className="meta mt-2 text-slate-green">drafted {approval.draftedAt}</p>
                {approval.payload ? (
                  <details className="mt-3">
                    <summary className="meta text-slate-green cursor-pointer">view details</summary>
                    <pre className="meta mt-2 whitespace-pre-wrap break-words text-faded-sage">
                      {JSON.stringify(approval.payload, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <DismissButton actionId={approval.id} />
                <ApproveButton actionId={approval.id} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
