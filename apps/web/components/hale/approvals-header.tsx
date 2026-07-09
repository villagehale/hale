import Link from 'next/link';

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
    <header className="rise rise-1 mb-8">
      <p className="eyebrow mb-3 text-faded-sage">awaiting you</p>
      {hasPending ? (
        <>
          <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
            <span className="text-apricot-deep">{pendingCount}</span> {draftWord} waiting for your
            yes.
          </h1>
          <p className="meta mt-1 text-slate-green">
            Hale drafts the response — you decide. It never acts on its own.
          </p>
        </>
      ) : (
        <>
          <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">
            all clear<span className="text-apricot-deep">.</span>
          </h1>
          <p className="meta mt-1 text-slate-green">
            Nothing is waiting on you. When Hale drafts something, it parks it here for your yes. It
            never acts on its own.
          </p>
          <Link href="/trail" className="link mt-4 inline-block">
            see what Hale has taken care of →
          </Link>
        </>
      )}
    </header>
  );
}
