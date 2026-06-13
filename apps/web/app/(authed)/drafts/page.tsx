import { PageCorner } from '~/components/hearth/page-corner';
import { Folio } from '~/components/hearth/folio';
import { ToneLabel } from '~/components/hearth/tone';
import { StreakLadder } from '~/components/hearth/streak-ladder';
import { ApproveButton } from '~/components/hearth/approve-button';
import { loadDrafts } from '~/lib/dashboard/queries';
import { DRAFT_LEVEL } from '~/lib/dashboard/mappers';

export default async function DraftsPage() {
  const drafts = await loadDrafts();

  return (
    <div>
      <PageCorner folio="iii" section="drafts · awaiting your eye" />

      <header className="rise rise-1 mb-16 lg:mb-20">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-8 lg:gap-x-12">
          <div className="lg:col-span-3">
            <span className="eyebrow">drafts</span>
            <p className="meta mt-2">
              {drafts.length === 0
                ? 'nothing awaiting your eye'
                : `${drafts.length} note${drafts.length === 1 ? '' : 's'} for you to read`}
            </p>
          </div>
          <div className="lg:col-span-9">
            <h1 className="font-display">
              notes <span className="text-apricot-deep">for your eye.</span>
            </h1>
          </div>
        </div>
      </header>

      {/* ── Reading note ───────────────────────────────────────────────── */}
      <section className="rise rise-2 mb-16 panel">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-8">
          <div className="lg:col-span-3">
            <span className="eyebrow">how to read this page</span>
          </div>
          <div className="lg:col-span-9 text-slate-green leading-relaxed">
            Each draft has a recipient, a body, and my reasoning. Approve the
            ones that read right. Edit the ones that almost do. Skip the ones
            that don't. Every approval earns this action class one rung up the
            trust ladder.
          </div>
        </div>
      </section>

      {/* ── Drafts ─────────────────────────────────────────────────────── */}
      {drafts.length === 0 ? (
        <section className="rise rise-3 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing on your desk right now.
          </p>
          <p className="meta mt-4 text-slate-green">
            no data yet — connect a data source and I'll start drafting the
            small notes, so you only ever read the ones worth your eye.
          </p>
        </section>
      ) : (
        <section>
          {drafts.map((draft, idx) => {
            const delay = `rise-${Math.min(idx + 3, 7)}`;
            return (
              <article
                key={draft.id}
                className={`rise ${delay} py-12 lg:py-14 border-t border-rule first:border-t-0`}
              >
                <div className="grid grid-cols-1 md:grid-cols-12 gap-y-6 md:gap-x-8">
                  <div className="md:col-span-2">
                    <Folio index={idx + 1} />
                    <p className="eyebrow text-spruce mt-3">{draft.category}</p>
                  </div>

                  <div className="md:col-span-7 space-y-6">
                    <div className="space-y-2">
                      <span className="meta">to · {draft.recipient}</span>
                      <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
                        {draft.subject}
                      </h2>
                    </div>

                    {/* the "letter body" — paper-toned panel */}
                    <div className="panel">
                      <p className="text-lg text-spruce leading-relaxed">{draft.body}</p>
                    </div>

                    {draft.rationale ? (
                      <div className="border-l-2 border-apricot-deep pl-5">
                        <span className="eyebrow text-spruce">why this draft</span>
                        <p className="mt-1 text-slate-green"><em>{draft.rationale}</em></p>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-2">
                      <ApproveButton actionId={draft.id} />
                      <button type="button" className="btn-ghost">edit</button>
                      <button type="button" className="btn-ghost">skip</button>
                      <button type="button" className="btn-ghost">always handle these</button>
                    </div>
                  </div>

                  <div className="md:col-span-3 md:border-l md:border-rule md:pl-6 space-y-4">
                    <ToneLabel tone="awaiting" />
                    <div>
                      <span className="eyebrow">trust ladder</span>
                      <div className="mt-2">
                        <StreakLadder level={DRAFT_LEVEL} />
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      <section className="rise rise-7 mt-16 lg:mt-20 pt-10 border-t border-rule flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
        <p className="meta">end of drafts</p>
        <p className="meta">nothing else awaiting</p>
      </section>
    </div>
  );
}
