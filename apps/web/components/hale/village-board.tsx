'use client';

import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  ExternalLink,
  Heart,
  Lock,
  Map as MapIcon,
  Search,
  Shield,
  Sparkles,
  Trees,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState } from 'react';
import { ActivityCard } from '~/components/hale/activity-card';
import { AcceptButton } from '~/components/hale/accept-button';
import { EndorseButton } from '~/components/hale/endorse-button';
import { SocialProofBadge } from '~/components/hale/public-surface';
import { SaveButton } from '~/components/hale/save-button';
import { ShareButton } from '~/components/hale/share-button';
import { VillageMap } from '~/components/hale/village-map';
import { Icon } from '~/components/ui/icon';
import { formatCalendarDate } from '~/lib/format/datetime';
import { villageKindLabel } from '~/lib/format/labels';
import { type BoardFilter, filterActivities, filterResources } from '~/lib/village/board-filter';
import type { CuratedResourceView } from '~/lib/village/curated-resources';
import type { LatLng } from '~/lib/village/map-model';
import type { VillageCandidateView } from '~/lib/village/mappers';
import { upcomingDatedCandidates } from '~/lib/village/upcoming';

/**
 * The Village board, desktop handoff §4.5: one search + the five content-type chips
 * over the REAL loaded data, then the 330px | 1fr | 300px layout — a results list
 * (nearby activities + trusted resources, filtered), the map panel (the real Google
 * Maps seam), and a right rail (Upcoming dated events, Saved items, and ONE ranked
 * recommendation clearly labelled). Everything filters over the rows already sent to
 * the page (no request, no new location signal — rule #1); the top-bar location
 * switcher re-queries the whole surface via router.refresh().
 *
 * The activity → interested drill-in is the shared selection: a list row (or a map
 * marker) selects a candidate, and its ActivityCard panel — the existing honest flow
 * (I'm interested / add to my week / endorse / share / register) — opens in the
 * centre column. A teen-attributed candidate stays locked (no raw text, no actions,
 * never selectable — rule #1). Resources are their real external destinations.
 *
 * Below 1024px the three columns collapse to a list-first stack and the map becomes a
 * collapsible section, so nothing overflows.
 */

const FILTERS: ReadonlyArray<{ value: BoardFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'activities', label: 'Activities' },
  { value: 'childcare', label: 'Childcare' },
  { value: 'resources', label: 'Resources' },
  { value: 'playgrounds', label: 'Playgrounds' },
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

export function VillageBoard({
  candidates,
  resources,
  coarseCenter,
  area = null,
  saved = [],
  ranked = false,
  showInlineSearch = true,
}: {
  candidates: VillageCandidateView[];
  resources: CuratedResourceView[];
  coarseCenter: LatLng | null;
  area?: string | null;
  /** The family's privately-saved candidates for the right rail (server read). */
  saved?: VillageCandidateView[];
  /** True when `candidates` is the agent's ranking (vs raw discovery order) — gates
   * the "Hale recommends" card so a recommendation is only ever shown when it is a
   * genuine ranked pick, never a fabricated one. */
  ranked?: boolean;
  /** The board's own instant literal-filter box. Hidden when the page mounts the
   * natural-language search above the board (which supersedes it); the type chips
   * still browse the loaded feed. Defaults on so every other caller is unchanged. */
  showInlineSearch?: boolean;
}) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const shownActivities = useMemo(
    () => filterActivities(candidates, filter, query),
    [candidates, filter, query],
  );
  const shownResources = useMemo(
    () => filterResources(resources, filter, query),
    [resources, filter, query],
  );

  // The rails are standing summaries over the full feed, independent of the chip:
  // dated events soonest-first, and the agent's top non-redacted pick.
  const upcoming = useMemo(() => upcomingDatedCandidates(candidates), [candidates]);
  const recommendation =
    ranked && candidates[0] && !candidates[0].teenAttributed ? candidates[0] : null;

  const byId = useMemo(() => {
    const map = new Map<string, VillageCandidateView>();
    for (const c of [...candidates, ...saved]) map.set(c.id, c);
    return map;
  }, [candidates, saved]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const resultCount = shownActivities.length + shownResources.length;

  return (
    <div className="space-y-6">
      {/* ── Search + filter chips (§4.5). The literal-filter box is hidden when the
           natural-language search is mounted above the board (it supersedes it); the
           type chips still browse the loaded feed. ─────────────────────────────── */}
      {showInlineSearch ? (
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-faded-sage">
            <Icon as={Search} size={18} />
          </span>
          <label htmlFor={searchId} className="sr-only">
            Search activities, childcare, resources
          </label>
          <input
            id={searchId}
            type="search"
            className="field field-search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search activities, childcare, resources…"
            autoComplete="off"
          />
        </div>
      ) : null}

      <fieldset
        className="flex flex-wrap gap-2 overflow-x-auto"
        aria-label="filter the village by type"
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

      {/* ── 330px | 1fr | 300px (collapses to list-first below 1024px) ────── */}
      <div className="village-3col">
        {/* Left — results list */}
        <section className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <span className="eyebrow text-faded-sage">
              Near you{area ? ' · ' : ''}
              {area ? (
                <span className="text-slate-green" data-hale-pii>
                  {area}
                </span>
              ) : null}
            </span>
            <span className="meta text-faded-sage shrink-0">
              {resultCount} {resultCount === 1 ? 'place' : 'places'}
            </span>
          </div>

          {resultCount === 0 ? (
            <output className="meta italic text-slate-green block">
              {query.trim()
                ? `nothing matches “${query.trim()}” near you.`
                : 'nothing to show here yet.'}
            </output>
          ) : (
            <ul className="space-y-3">
              {shownActivities.map((candidate) => (
                <li key={candidate.id}>
                  <ActivityRow
                    candidate={candidate}
                    selected={candidate.id === selectedId}
                    onSelect={setSelectedId}
                  />
                </li>
              ))}
              {shownResources.map((resource) => (
                <li key={resource.id}>
                  <ResourceRow resource={resource} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Centre — the real map + the shared activity drill-in */}
        <section className="min-w-0">
          <MapPanel
            candidates={shownActivities}
            coarseCenter={coarseCenter}
            area={area}
            onSelect={setSelectedId}
          />
          {selected && !selected.teenAttributed ? (
            <div className="mt-5">
              <ActivityCard
                candidate={selected}
                variant="panel"
                area={area}
                onClose={() => setSelectedId(null)}
              />
            </div>
          ) : null}
        </section>

        {/* Right — Upcoming / Saved / one ranked recommendation */}
        <aside className="village-rail min-w-0">
          <RailSection label="Upcoming">
            {upcoming.length === 0 ? (
              <p className="meta italic text-slate-green">no dated events coming up.</p>
            ) : (
              <ul className="space-y-1">
                {upcoming.slice(0, 4).map((candidate) => (
                  <li key={candidate.id}>
                    <RailRow
                      title={candidate.title}
                      meta={formatCalendarDate(candidate.eventDate)}
                      teen={candidate.teenAttributed}
                      onSelect={() => setSelectedId(candidate.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </RailSection>

          <RailSection
            label="Saved"
            action={
              saved.length > 0 ? (
                <Link href="/saved" className="link text-[0.8rem]">
                  See all
                </Link>
              ) : null
            }
          >
            {saved.length === 0 ? (
              <p className="meta italic text-slate-green">nothing saved yet.</p>
            ) : (
              <ul className="space-y-1">
                {saved.slice(0, 5).map((candidate) => (
                  <li key={candidate.id}>
                    <RailRow
                      title={candidate.title}
                      meta={villageKindLabel(candidate.kind) ?? 'saved'}
                      teen={candidate.teenAttributed}
                      onSelect={() => setSelectedId(candidate.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </RailSection>

          {recommendation ? (
            <RecommendationCard
              candidate={recommendation}
              onSelect={() => setSelectedId(recommendation.id)}
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}

/** The map, collapsible below 1024px (design handoff §4.5: the map becomes a
 * collapsible section on narrow viewports). The map is mounted only when it is
 * visible — on desktop, or when the parent expands it on mobile — so a collapsed
 * mobile map never boots Google Maps it will never show, and the map always
 * initialises at its real container width. */
function MapPanel({
  candidates,
  coarseCenter,
  area,
  onSelect,
}: {
  candidates: VillageCandidateView[];
  coarseCenter: LatLng | null;
  area: string | null;
  onSelect: (id: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const showMap = mounted && (isDesktop || open);

  return (
    <div className="village-map-panel">
      {mounted && !isDesktop ? (
        <button
          type="button"
          className="village-map-toggle"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
        >
          <Icon as={MapIcon} size={18} className="shrink-0" />
          {open ? 'Hide map' : 'Show map'}
        </button>
      ) : null}

      {showMap ? (
        <VillageMap
          candidates={candidates}
          coarseCenter={coarseCenter}
          area={area}
          onSelect={onSelect}
        />
      ) : !mounted ? (
        <div className="village-map-placeholder panel-oat">
          <p className="meta text-slate-green">loading the map…</p>
        </div>
      ) : null}
    </div>
  );
}

/** A right-rail section: an eyebrow, an optional trailing action, then its rows. */
function RailSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="village-rail-section">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="eyebrow text-faded-sage">{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A compact right-rail row (Upcoming / Saved): a selectable title + a meta line. A
 * teen-attributed entry can't reach the rails (dated events are nulled at the mapper
 * and Saved redacts to category), but is defended here too — locked, not selectable. */
function RailRow({
  title,
  meta,
  teen,
  onSelect,
}: {
  title: string;
  meta: string;
  teen: boolean;
  onSelect: () => void;
}) {
  if (teen) {
    return (
      <div className="village-rail-row flex items-center gap-2 text-slate-green">
        <Icon as={Lock} size={14} className="shrink-0" />
        <span className="meta">{title}</span>
      </div>
    );
  }
  return (
    <button type="button" className="village-rail-row village-rail-row-button" onClick={onSelect}>
      <span className="min-w-0 flex-1">
        <span className="village-rail-row-title" data-hale-pii>
          {title}
        </span>
        <span className="meta text-faded-sage block">{meta}</span>
      </span>
      <Icon as={ChevronRight} size={15} className="shrink-0 text-faded-sage" />
    </button>
  );
}

/** The ONE ranked recommendation — clearly labelled as the agent's top pick, never a
 * fabricated highlight (only rendered when `ranked` and the top pick is previewable). */
function RecommendationCard({
  candidate,
  onSelect,
}: {
  candidate: VillageCandidateView;
  onSelect: () => void;
}) {
  const kindLabel = villageKindLabel(candidate.kind);
  return (
    <section className="village-rec">
      <span className="village-rec-eyebrow eyebrow">Hale recommends</span>
      <p className="village-rec-title font-display text-spruce" data-hale-pii>
        {candidate.title}
      </p>
      <p className="meta text-slate-green mt-1">
        {kindLabel ? `${kindLabel} · ` : ''}ranked first for your family this week
      </p>
      <button type="button" className="village-rec-link" onClick={onSelect}>
        See details
        <Icon as={ChevronRight} size={15} className="shrink-0" />
      </button>
    </section>
  );
}

/** A compact activity row: a type glyph, a selectable title + an "Activity" / kind
 * label and the when/date line, then the village's moat actions — add to my week
 * (accept), the private save ("I'm interested"), endorse, and share. No distance, no
 * photo (village candidates carry neither). A teen-attributed row shows the locked
 * treatment — no raw text, no actions, not selectable (rule #1). */
function ActivityRow({
  candidate,
  selected,
  onSelect,
}: {
  candidate: VillageCandidateView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
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
    <div className={`card flex flex-col gap-3 ${selected ? 'village-row-selected' : ''}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--r-md)] bg-linen text-spruce">
          <Icon as={glyph} size={18} />
        </span>
        <button
          type="button"
          className="village-row-title min-w-0 flex-1 text-left"
          onClick={() => onSelect(candidate.id)}
          aria-pressed={selected}
        >
          <span className="font-display text-[1.05rem] leading-snug text-spruce block" data-hale-pii>
            {candidate.title}
          </span>
          <span className="meta mt-1 text-slate-green block">
            {kindLabel ? `${kindLabel} · Activity` : 'Activity'}
            {when ? ` · ${when}` : ''}
          </span>
        </button>
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
