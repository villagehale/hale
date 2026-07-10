'use client';

import {
  BookOpen,
  CalendarDays,
  ExternalLink,
  Heart,
  List,
  Lock,
  Map as MapIcon,
  Search,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Trees,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { SocialProofBadge } from '~/components/hale/public-surface';
import { SaveButton } from '~/components/hale/save-button';
import { ShareButton } from '~/components/hale/share-button';
import { VillageMap } from '~/components/hale/village-map';
import { Icon } from '~/components/ui/icon';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import {
  type BoardFilter,
  filterActivities,
  filterResources,
} from '~/lib/village/board-filter';
import type { CuratedResourceView } from '~/lib/village/curated-resources';
import type { LatLng } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';

/**
 * The Village board (mockup panel 4): one search + a content-type filter row over
 * the REAL loaded data, then two columns — Nearby activities (the agent-ranked
 * candidate feed) and Trusted resources (the curated directory). Everything filters
 * over the rows already sent to the page (no request, no new location signal — rule
 * #1). Honesty: no distance and no photos (village candidates carry neither); a
 * teen-attributed candidate renders locked, never its raw text (rule #1).
 *
 * The map stays reachable as a list/map toggle in the activities column — the
 * spatial companion over the same filtered candidates, centered on the coarse area
 * (VillageMap enforces rule #1), so the preserved map view isn't lost to the board.
 */

const FILTERS: ReadonlyArray<{ value: BoardFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'activities', label: 'Activities' },
  { value: 'resources', label: 'Resources' },
  { value: 'childcare', label: 'Childcare' },
];

/** Category → glyph for the curated resource rows. Unknown categories fall back to
 * a neutral shield (a verified-directory glyph), never a fabricated one. */
const RESOURCE_ICON: Record<string, LucideIcon> = {
  'EarlyON child & family centres': Users,
  "Public library children's programs": BookOpen,
  'Parks & splash pads': Trees,
  'Public health': Shield,
  'Community/recreation centres': Users,
};

/** Village kind → glyph for the compact activity rows. Unknown/other kinds fall
 * back to the generic sparkles used across the app for a village pick. */
const KIND_ICON: Record<string, LucideIcon> = {
  class: Sparkles,
  program: CalendarDays,
  drop_in: Users,
  outdoor: Trees,
  library: BookOpen,
  community_event: CalendarDays,
};

const CADENCE_WHEN: Record<string, string> = {
  seasonal: 'seasonal',
  'one-time': 'one-time',
  ongoing: 'year-round',
};

type View = 'list' | 'map';

export function VillageBoard({
  candidates,
  resources,
  coarseCenter,
  area = null,
}: {
  candidates: VillageCandidateView[];
  resources: CuratedResourceView[];
  coarseCenter: LatLng | null;
  area?: string | null;
}) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [view, setView] = useState<View>('list');

  const shownActivities = useMemo(
    () => filterActivities(candidates, filter, query),
    [candidates, filter, query],
  );
  const shownResources = useMemo(
    () => filterResources(resources, filter, query),
    [resources, filter, query],
  );

  const showActivities = filter === 'all' || filter === 'activities';
  const showResources = filter !== 'activities';

  return (
    <div className="space-y-6">
      {/* ── Search + filter row ─────────────────────────────────────────── */}
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage">
          <Icon as={Search} size={18} />
        </span>
        <label htmlFor={searchId} className="sr-only">
          Search activities or resources
        </label>
        <input
          id={searchId}
          type="search"
          className="field field-search pr-12"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search activities or resources"
          autoComplete="off"
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-faded-sage">
          <Icon as={SlidersHorizontal} size={18} />
        </span>
      </div>

      <fieldset
        className="flex flex-wrap gap-2 overflow-x-auto"
        aria-label="filter by activities or resources"
      >
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(option.value)}
              className={`pill pill-action shrink-0 ${
                active ? 'bg-spruce text-on-spruce' : 'text-slate-green'
              }`}
              style={{ touchAction: 'manipulation' }}
            >
              {option.label}
            </button>
          );
        })}
      </fieldset>

      {/* ── Two columns: activities + resources (stack on mobile) ───────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-10 lg:items-start">
        {showActivities ? (
          <section className="min-w-0">
            <ColumnHeader
              label="Nearby activities"
              onSeeAll={() => setFilter('activities')}
              seeAllActive={filter === 'activities'}
            />

            <div className="mb-4">
              <ViewToggle view={view} onChange={setView} />
            </div>

            {view === 'map' ? (
              <VillageMap candidates={shownActivities} coarseCenter={coarseCenter} area={area} />
            ) : shownActivities.length === 0 ? (
              <output className="meta italic text-slate-green block">
                {query.trim()
                  ? `nothing matches “${query.trim()}” this week.`
                  : 'no activities near you yet.'}
              </output>
            ) : (
              <ul className="space-y-3">
                {shownActivities.map((candidate) => (
                  <li key={candidate.id}>
                    <ActivityRow candidate={candidate} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {showResources ? (
          <section className="min-w-0">
            <ColumnHeader
              label="Trusted resources"
              onSeeAll={() => setFilter('resources')}
              seeAllActive={filter === 'resources' || filter === 'childcare'}
            />
            {shownResources.length === 0 ? (
              <output className="meta italic text-slate-green block">
                {query.trim()
                  ? `nothing matches “${query.trim()}”.`
                  : 'no resources to show right now.'}
              </output>
            ) : (
              <ul className="space-y-3">
                {shownResources.map((resource) => (
                  <li key={resource.id}>
                    <ResourceRow resource={resource} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ColumnHeader({
  label,
  onSeeAll,
  seeAllActive,
}: {
  label: string;
  onSeeAll: () => void;
  seeAllActive: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-4">
      <span className="eyebrow text-faded-sage">{label}</span>
      <button
        type="button"
        onClick={onSeeAll}
        aria-pressed={seeAllActive}
        className="link text-[0.85rem]"
      >
        See all
      </button>
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (next: View) => void }) {
  return (
    <fieldset
      className="inline-flex rounded-[var(--r-full)] border border-rule-strong p-1"
      aria-label="view activities as a list or a map"
    >
      {(
        [
          { value: 'list', label: 'list', icon: List },
          { value: 'map', label: 'map', icon: MapIcon },
        ] as const
      ).map((option) => {
        const active = view === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`inline-flex min-h-[44px] items-center gap-2 rounded-[var(--r-full)] px-4 cursor-pointer transition-colors ${
              active ? 'bg-spruce text-on-spruce' : 'text-slate-green'
            }`}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon as={option.icon} size={18} className="shrink-0" />
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** A compact activity row: a type glyph, the title + an "Activity" / kind label and
 * the when/date line, then the village's moat actions — add to my week (accept),
 * endorse, share, and the private save — kept small and wrapping so the card stays
 * tidy. No distance, no photo (village candidates carry neither). A teen-attributed
 * row shows the locked treatment — no raw text, no actions (rule #1). */
function ActivityRow({ candidate }: { candidate: VillageCandidateView }) {
  const kindLabel = villageKindLabel(candidate.kind);

  if (candidate.teenAttributed) {
    return (
      <div className="card flex items-center gap-3">
        <Icon as={Lock} size={18} className="shrink-0 text-slate-green" />
        <p className="meta text-slate-green">{candidate.title}</p>
      </div>
    );
  }

  const glyph = KIND_ICON[candidate.kind] ?? Sparkles;
  const when = whenLine(candidate);

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-linen text-spruce">
          <Icon as={glyph} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-[1.05rem] leading-snug text-spruce" data-hale-pii>
            {candidate.title}
          </p>
          <p className="meta mt-1 text-slate-green">
            {kindLabel ? `${kindLabel} · Activity` : 'Activity'}
            {when ? ` · ${when}` : ''}
          </p>
        </div>
        <SocialProofBadge count={candidate.endorsementCount} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-12">
        <AcceptButton href={candidate.acceptHref} initiallyAccepted={candidate.accepted} />
        <SaveButton endpoint={candidate.saveHref} initiallySaved={candidate.saved} />
        <EndorseButton
          endpoint={candidate.endorseHref}
          initiallyEndorsed={candidate.endorsedByFamily}
        />
        <ShareButton
          endpoint={candidate.shareHref}
          label="share"
          shareTitle={candidate.title}
          variant="ghost"
        />
      </div>
    </div>
  );
}

/** The "when" line for a compact row: a dated event reads as its concrete calendar
 * day, an undated activity as its human cadence label. Null cadence AND null date →
 * the row shows no when-line, never a fabricated date or distance (rule #1). */
function whenLine(candidate: VillageCandidateView): string | null {
  if (candidate.eventDate) return formatCalendarDate(candidate.eventDate);
  if (candidate.cadence) return CADENCE_WHEN[candidate.cadence] ?? candidate.cadence;
  return null;
}

function ResourceRow({ resource }: { resource: CuratedResourceView }) {
  const glyph = RESOURCE_ICON[resource.category] ?? Heart;
  return (
    <a
      href={resource.url}
      target="_blank"
      rel="noreferrer"
      className="card card-interactive group flex items-start gap-3"
    >
      <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-linen text-spruce">
        <Icon as={glyph} size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-display text-[1.05rem] leading-snug text-spruce group-hover:text-apricot-deep">
          {resource.name}
        </p>
        <p className="meta mt-1 text-slate-green">{resource.category}</p>
        <p className="meta text-faded-sage">{resource.description}</p>
      </div>
      <Icon
        as={ExternalLink}
        size={16}
        className="mt-1 shrink-0 text-slate-green group-hover:text-apricot-deep"
      />
    </a>
  );
}
