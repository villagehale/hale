import { Suspense } from 'react';
import { BuildYourVillage } from '~/components/hale/build-your-village';
import { PrivacyNote } from '~/components/hale/privacy-note';
import { ResourcesRail } from '~/components/hale/resources-rail';
import {
  VillageCandidates,
  VillageFeedSkeleton,
  VillageSearchRun,
} from '~/components/hale/village-feed-section';
import { VillageSeasonSelector } from '~/components/hale/village-season-selector';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { loadCuratedResources } from '~/lib/village/curated-resources';
import { loadVillage } from '~/lib/village/queries';
import { seasonFromParam } from '~/lib/village/season-selector-ui';

/** A clean, minimal section label (Notion/Linear register) — small, muted, spaced
 * above its content. Replaces the editorial label-rail gutters. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow mb-3 text-faded-sage">{children}</p>;
}

export default async function VillagePage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season } = await searchParams;
  const activeSeason = seasonFromParam(season);
  // The standing weekly routine belongs to the standing feed, not a forward-looking
  // season search — so it (and its loadVillage read) is skipped on a search view.
  const [{ routine }, resources] = await Promise.all([
    activeSeason ? Promise.resolve({ routine: null }) : loadVillage(),
    loadCuratedResources(),
  ]);
  const hasRoutine = (routine?.items.length ?? 0) > 0;

  return (
    <div>
      {/* ── Headline — the modest, app-like header the live pages share. ── */}
      <header className="rise rise-1 mb-8">
        <h1 className="font-display text-[1.75rem] lg:text-[2rem] leading-tight">Village</h1>
        <p className="meta mt-1 text-slate-green">
          Find trusted support, activities, care and resources for your family.
        </p>
      </header>

      {/* ── The board (search + near-you list + map + right rail), or a season
           search RUN. Both stream behind Suspense so the shell renders instantly. ── */}
      <div className="rise rise-2">
        <Suspense fallback={<VillageFeedSkeleton />}>
          {activeSeason ? <VillageSearchRun season={activeSeason} /> : <VillageCandidates />}
        </Suspense>
      </div>

      {/* ── Season search — pick a future season, or clear back to your feed. Stays
           visible during a run so a parent can switch seasons directly. ────────── */}
      <section className="rise rise-3 mt-16 lg:mt-20">
        <SectionLabel>look ahead to a season</SectionLabel>
        <VillageSeasonSelector active={activeSeason} />
      </section>

      {/* ── Below the board: the calmer, preserved sections. A season search stays
           focused on its results, so these are the standing view only. ─────────── */}
      {activeSeason ? null : (
        <div className="mt-12 space-y-12">
          {/* ── This week's routine ───────────────────────────────────────────── */}
          {routine && hasRoutine ? (
            <section className="rise rise-4">
              <SectionLabel>a gentle routine · week of {formatCalendarDate(routine.weekOf)}</SectionLabel>
              <div className="panel space-y-5">
                {routine.items.map((item, idx) => {
                  const kindLabel = villageKindLabel(item.kind);
                  return (
                    <div
                      key={`${item.kind}-${idx}`}
                      className="flex items-baseline gap-4 border-t border-rule pt-5 first:border-t-0 first:pt-0"
                    >
                      {kindLabel ? (
                        <span className="eyebrow text-spruce shrink-0">{kindLabel}</span>
                      ) : null}
                      <div data-hale-pii>
                        <p className="text-lg text-spruce leading-relaxed">{item.title}</p>
                        {item.stageNote ? (
                          <p className="meta mt-1 text-slate-green">{item.stageNote}</p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* ── Build your village (the growth engine) ──────────────────────── */}
          <section className="rise rise-4">
            <BuildYourVillage nothingToShare={!hasRoutine} />
          </section>

          {/* ── Resources — the calm, curated directory rail ─────────────────── */}
          <ResourcesRail resources={resources} />
        </div>
      )}

      {/* ── Colophon ────────────────────────────────────────────────────── */}
      <section className="rise rise-7 mt-16 lg:mt-20 space-y-6">
        <div className="panel-oat px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="meta">
            Hale only ever uses your neighbourhood, never your exact address.
          </span>
          <PrivacyNote />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-y-3 text-faded-sage">
          <p className="meta">this week's village</p>
          <p className="meta">gathered by Hale</p>
        </div>
      </section>
    </div>
  );
}
