/**
 * The Approvals page header — state-adaptive, because the pending count IS the
 * information. With nothing pending it reads "all clear" and IS the empty state
 * (there is no separate empty panel). With N drafts waiting it leads with the
 * count as the hero numeral, and the list of rows follows beneath it.
 *
 * The trust promise rides as the meta in both states (rule #4 made visible): Hale
 * only ever drafts; the parent decides; it never acts on its own.
 */
export function ApprovalsHeader({ pendingCount }: { pendingCount: number }) {
  const hasPending = pendingCount > 0;
  const draftWord = pendingCount === 1 ? 'draft' : 'drafts';

  return (
    <header className="rise rise-1 mb-16 lg:mb-20">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
        <div className="lg:col-span-3">
          <span className="eyebrow">awaiting you</span>
          <p className="meta mt-2 text-slate-green max-w-prose">
            Hale drafts the response — you decide. It never acts on its own.
          </p>
        </div>
        <div className="lg:col-span-9">
          {hasPending ? (
            <h1 className="font-display">
              <span className="text-apricot-deep">{pendingCount}</span> {draftWord} waiting for your
              yes.
            </h1>
          ) : (
            <>
              <h1 className="font-display">
                all clear<span className="text-apricot-deep">.</span>
              </h1>
              <p className="meta mt-4 text-slate-green max-w-prose">
                when a signal comes in, Hale parks it here for your approval.
              </p>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
