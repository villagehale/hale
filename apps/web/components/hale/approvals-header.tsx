import Link from 'next/link';
import { Mascot } from '~/components/hale/mascot';

/**
 * The Approvals intro, sitting beneath the shell's "Approvals" drill hero
 * (design handoff §3.2 — the page no longer carries its own title). It is
 * state-adaptive: with drafts waiting it is a single trust line (rule #4 made
 * visible — Hale only ever drafts; the parent decides); with nothing pending it
 * IS the empty state (§4.8 "All caught up"), a calm mascot panel that still
 * points to the record of what Hale has handled, so it never dead-ends.
 */
export function ApprovalsHeader({ pendingCount }: { pendingCount: number }) {
  if (pendingCount === 0) {
    return (
      <section className="rise rise-1 panel-oat px-6 py-12 lg:py-16 text-center space-y-4">
        <Mascot pose="swim" size={104} className="mx-auto" />
        <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">All caught up</p>
        <p className="meta text-slate-green max-w-xl mx-auto">
          Nothing waiting for your approval. When Hale drafts something, it parks it here for your
          yes. It never acts on its own.
        </p>
        <div className="pt-2">
          <Link href="/trail" className="link">
            see what Hale has taken care of &rarr;
          </Link>
        </div>
      </section>
    );
  }

  return (
    <p className="rise rise-1 meta mb-6 text-slate-green">
      Hale drafts the response &mdash; you decide. It never acts on its own.
    </p>
  );
}
