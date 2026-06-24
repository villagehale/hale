import { PageCorner } from '~/components/hale/page-corner';
import { CoachConversation } from '~/components/hale/coach-conversation';
import { authConfigured } from '~/lib/auth-config';
import { loadThreadShellForRequest } from '~/lib/coach/thread';

export default async function CoachPage({
  searchParams,
}: {
  searchParams: Promise<{ child?: string }>;
}) {
  const canAsk = authConfigured();
  const askSeed = await loadThreadShellForRequest();
  const { child } = await searchParams;
  // Contextual entry (e.g. from a child's companion page): pre-scope to that child,
  // but only if it's actually one of this family's children (no arbitrary id).
  const initialFocusedChildId = askSeed.children.some((c) => c.id === child) ? (child ?? null) : null;

  return (
    <div>
      <PageCorner folio="ask" section="ask Hale · anything" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">ask Hale</span>
            <p className="meta mt-2">one ongoing conversation · grounded in your family</p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              ask Hale <span className="text-apricot-deep">anything.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 panel">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow">how this works</span>
          </div>
          <div className="lg:col-span-9 text-slate-green leading-relaxed text-lg">
            I answer in plain language and cite the framework or source. I will
            not give medical advice; if a question crosses that line, I will say
            so and point you to your pediatrician.
          </div>
        </div>
      </section>

      <CoachConversation
        canAsk={canAsk}
        seed={askSeed}
        initialFocusedChildId={initialFocusedChildId}
      />
    </div>
  );
}
