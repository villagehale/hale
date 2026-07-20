'use client';

import {
  Baby,
  Brain,
  CalendarCheck,
  Check,
  ChevronRight,
  FileText,
  Footprints,
  MessageCircle,
  Moon,
  Sparkles,
  Stethoscope,
  UserPlus,
  Users,
  Utensils,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Icon } from '~/components/ui/icon';
import {
  COMPANION_TABS,
  type CompanionTabKey,
} from '~/lib/companion/companion-tabs-nav';
import {
  buildDevelopmentSnapshot,
  type DevelopmentSnapshot,
} from '~/lib/companion/development-snapshot';
import { buildMeasureSeries, type MeasureSeries } from '~/lib/companion/growth-series';
import type { GrowthHeaderStat } from '~/lib/companion/growth-header';
import { displayMeasurement, type UnitSystem } from '@hale/types';
import {
  BOOKING_EPISODE,
  FEED_EPISODE,
  type MeasureKind,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import { type LogView, percentileOrdinal } from '~/lib/companion/logs-view';
import type { ChildCompanionView } from '~/lib/companion/queries';
import type { RecentLogView } from '~/lib/companion/recent-logs';
import type { DocumentView } from '~/lib/docs/documents';
import type { FamilyMembersView } from '~/lib/dashboard/family-members';
import { formatCalendarDate, formatWhenPhrase } from '~/lib/format/datetime';
import type { RoutineProposalView } from '~/lib/village/mappers';
import { BookButton } from './book-button';
import { DoneButton } from './done-button';

const STAGE_LABEL: Record<ChildCompanionView['stage'], string> = {
  newborn: 'newborn',
  toddler: 'toddler',
  child: 'school-age',
  teenager: 'teenager',
};

const TIMING_LABEL: Record<ChildCompanionView['milestones'][number]['timing'], string> = {
  upcoming: 'coming up',
  in_window: 'around now',
  watch: 'worth asking',
};

const LOG_ICON: Record<string, LucideIcon> = {
  [FEED_EPISODE]: Utensils,
  [NAP_EPISODE]: Moon,
  [MILESTONE_EPISODE]: Sparkles,
  [BOOKING_EPISODE]: Stethoscope,
};

const MILESTONE_AREA_ICON: Record<ChildCompanionView['milestones'][number]['area'], LucideIcon> = {
  motor: Footprints,
  language: MessageCircle,
  social: Users,
  cognitive: Brain,
  independence: Baby,
};

/** The three header stats, in the design-handoff order (Height / Weight / Head). */
const HEADER_STAT_ORDER: { kind: MeasureKind; label: string }[] = [
  { kind: 'height', label: 'Height' },
  { kind: 'weight', label: 'Weight' },
  { kind: 'head', label: 'Head' },
];

/**
 * Roving-tablist keyboard model: given the pressed key, the active index, and the
 * tab count, return the index to move to — or null for keys the tablist ignores.
 * Arrow keys wrap around both ends; Home/End jump to the ends. Pure so the
 * wraparound/edge behaviour is testable without a DOM.
 */
export function nextTabIndex(key: string, active: number, count: number): number | null {
  const last = count - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return active === last ? 0 : active + 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return active === 0 ? last : active - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/**
 * Reflect the active sub-tab in the URL (`?tab=`) without a server round-trip or a
 * router hook — the History API keeps renderToStaticMarkup (the component-test
 * convention) working AND lets a deep link / refresh land on the same tab (the
 * server reads `?tab=` and seeds `initialTab`). Guarded for SSR.
 */
function writeTabToUrl(key: CompanionTabKey): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('tab', key);
  window.history.replaceState(window.history.state, '', url);
}

function agePhrase(ageMonths: number): string {
  if (ageMonths === 0) return 'under a month';
  if (ageMonths < 24) return `${ageMonths} ${ageMonths === 1 ? 'month' : 'months'}`;
  const years = Math.floor(ageMonths / 12);
  return `${years} ${years === 1 ? 'year' : 'years'}`;
}

function duePhrase(dueInWeeks: number): string {
  if (dueInWeeks <= 0) return 'due now';
  if (dueInWeeks === 1) return 'in 1 week';
  if (dueInWeeks < 8) return `in ${dueInWeeks} weeks`;
  const months = Math.round(dueInWeeks / 4.345);
  return `in ~${months} ${months === 1 ? 'month' : 'months'}`;
}

/** "12-18 months" — the typical age window for a milestone. Years past 24 months so
 * a school-age window doesn't read in the hundreds. */
function windowPhrase(window: readonly [number, number]): string {
  const [from, to] = window;
  if (to < 24) return `${from}-${to} months`;
  const yearOf = (m: number) => Math.round(m / 12);
  return `${yearOf(from)}-${yearOf(to)} years`;
}

/** The calendar date a health item is scheduled for: the child's date of birth plus
 * the item's scheduled age in months, in UTC so the parent-typed day round-trips. */
function healthDate(dateOfBirth: string, ageMonths: number): Date {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + ageMonths, d ?? 1));
}

/** "scheduled at 4 months" — the age a passed health item was set for. Warm, not
 * "overdue". */
function passedAtPhrase(ageMonths: number): string {
  if (ageMonths < 24) return `scheduled at ${ageMonths} ${ageMonths === 1 ? 'month' : 'months'}`;
  const years = Math.floor(ageMonths / 12);
  return `scheduled at ${years} ${years === 1 ? 'year' : 'years'}`;
}

/** The one health thing worth leading with, horizon-gated, or the standing note. */
function leadLine(child: ChildCompanionView): string {
  const soonest = child.todayHealth;
  if (soonest) return `${soonest.what} — ${duePhrase(soonest.dueInWeeks)}.`;
  return 'Nothing on the standard schedule right now — keep up periodic visits.';
}

function firstName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? 'your child';
}

/** The child's first initial for the neutral avatar placeholder — we hold no child
 * photo, so a calm monogram stands in (never a fabricated face). */
function initialOf(name: string | null): string {
  return firstName(name).charAt(0).toUpperCase() || '·';
}

/** "May 12, 2024" — a birth date always carries its year, read in UTC so the bare
 * `YYYY-MM-DD` the parent typed round-trips. */
function birthDate(dateOfBirth: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateOfBirth}T00:00:00Z`));
}

/** A compact human size for a document row (e.g. "1.2 MB", "340 KB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ── CHILD-HUB HEADER (§4.3) ───────────────────────────────────────────────────
//
// Identity (monogram avatar + name + age · DOB) and the three growth stats with
// their REAL WHO percentile (from buildGrowthHeader on the server). Uses <h2> — the
// single page hero ("Companion") lives in the shell top bar (§3.2); this is the
// per-child identity block, not a competing page hero. Every child-identifying field
// sits under [data-hale-pii] so session replay masks it (rule #1).

function HeaderStat({
  label,
  stat,
  units,
}: {
  label: string;
  stat: GrowthHeaderStat | undefined;
  units: UnitSystem;
}) {
  if (!stat) {
    return (
      <div className="comp-stat">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-faded-sage">
          {label}
        </span>
        <span className="text-lg font-bold text-faded-sage tabular">—</span>
        <span className="meta text-faded-sage">no reading yet</span>
      </div>
    );
  }
  const shown = displayMeasurement(stat.valueMetric, stat.kind, units);
  const percentile = stat.assessment.state === 'assessed' ? stat.assessment.percentile : null;
  return (
    <div className="comp-stat" data-hale-pii>
      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-faded-sage">
        {label}
      </span>
      <span className="text-lg font-bold text-spruce tabular">
        {shown.value} {shown.unit}
      </span>
      <span className="meta text-faded-sage">
        {percentile !== null ? `${percentileOrdinal(percentile)} %ile` : 'WHO %ile — add details'}
      </span>
    </div>
  );
}

function ChildHubHeader({
  child,
  stats,
  units,
  onViewGrowth,
}: {
  child: ChildCompanionView;
  stats: GrowthHeaderStat[];
  units: UnitSystem;
  onViewGrowth: () => void;
}) {
  const byKind = new Map(stats.map((s) => [s.kind, s]));
  return (
    <div className="comp-hub">
      <div className="comp-hub-id" data-hale-pii>
        <span className="comp-hub-avatar">{initialOf(child.name)}</span>
        <div className="min-w-0">
          <h2 className="comp-hub-name font-display">{child.name ?? 'your child'}</h2>
          <p className="meta mt-1 text-slate-green">
            {agePhrase(child.ageMonths)} · {birthDate(child.dateOfBirth)}
          </p>
        </div>
      </div>
      <div className="comp-hub-right">
        <div className="comp-hub-stats">
          {HEADER_STAT_ORDER.map(({ kind, label }) => (
            <HeaderStat key={kind} label={label} stat={byKind.get(kind)} units={units} />
          ))}
        </div>
        <button
          type="button"
          onClick={onViewGrowth}
          className="link inline-flex items-center gap-1 cursor-pointer self-start"
        >
          View growth <Icon as={ChevronRight} size={16} />
        </button>
      </div>
    </div>
  );
}

// ── OVERVIEW (§4.3) ───────────────────────────────────────────────────────────
//
// A 3-col grid — Today at a glance (the folded "diary": this child's recent logs),
// the Development snapshot donut (real per-domain milestone progress), and a small
// stack (insight + health summary) — over a full-width Care team & contacts card.
// Nothing fabricated: an empty recent-logs / all-not-done donut each show a calm
// honest state.

function DevelopmentDonut({ snapshot }: { snapshot: DevelopmentSnapshot }) {
  const { total, done } = snapshot;
  // Each done milestone is an equal slice coloured by its domain; the remainder is
  // the neutral track. done === 0 → an all-track ring (the honest empty shape, never
  // a fabricated distribution).
  const stops: string[] = [];
  let filled = 0;
  for (const domain of snapshot.domains) {
    for (let i = 0; i < domain.done; i++) {
      const start = (filled / total) * 100;
      filled += 1;
      const end = (filled / total) * 100;
      stops.push(`var(--domain-${domain.area}) ${start}% ${end}%`);
    }
  }
  if (filled < total) {
    stops.push(`var(--color-hairline) ${(filled / total) * 100}% 100%`);
  }
  const gradient = `conic-gradient(from -90deg, ${stops.join(', ')})`;
  return (
    <div className="comp-donut" style={{ background: gradient }} aria-hidden="true">
      <div className="comp-donut-hole">
        <span className="comp-donut-count">
          {done}
          <span className="comp-donut-total">/{total}</span>
        </span>
        <span className="comp-donut-label">marked</span>
      </div>
    </div>
  );
}

export function OverviewSection({
  child,
  recentLogs,
  members,
  viewerEmail,
  timeZone,
  onNavigate,
}: {
  child: ChildCompanionView;
  recentLogs: RecentLogView[];
  members: FamilyMembersView;
  viewerEmail: string | null;
  timeZone: string;
  onNavigate: (s: CompanionTabKey) => void;
}) {
  const childLogs = recentLogs.filter((l) => l.childId === child.id).slice(0, 5);
  const snapshot = buildDevelopmentSnapshot(child.milestones);

  return (
    <div className="space-y-6">
      <div className="comp-overview">
        {/* Today at a glance */}
        <div className="card comp-ov-card">
          <span className="eyebrow text-faded-sage">today at a glance</span>
          {childLogs.length === 0 ? (
            <p className="meta mt-4 text-slate-green">
              nothing logged for <span data-hale-pii>{firstName(child.name)}</span> yet — note a
              feed, nap or milestone with quick log and it gathers here.
            </p>
          ) : (
            <ul className="mt-4 space-y-1 flex-1">
              {childLogs.map((log) => (
                <li key={log.id} className="flex items-baseline gap-3 py-2">
                  <span className="shrink-0 text-apricot-deep">
                    <Icon as={LOG_ICON[log.episodeType] ?? CalendarCheck} size={16} />
                  </span>
                  <span
                    className="min-w-0 flex-1 text-[0.95rem] text-spruce leading-snug"
                    data-hale-pii
                  >
                    {log.summary}
                  </span>
                  <span className="meta shrink-0 text-faded-sage">
                    {formatWhenPhrase(log.occurredAt, timeZone)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/companion/logs" className="link mt-4 inline-flex items-center gap-1">
            View full timeline <Icon as={ChevronRight} size={16} />
          </Link>
        </div>

        {/* Development snapshot */}
        <div className="card comp-ov-card">
          <div className="flex items-baseline justify-between gap-4">
            <span className="eyebrow text-faded-sage">development snapshot</span>
            <button
              type="button"
              onClick={() => onNavigate('milestones')}
              className="link text-sm cursor-pointer"
            >
              see all
            </button>
          </div>
          <div className="mt-4 flex flex-col items-center gap-4 flex-1 justify-center">
            <DevelopmentDonut snapshot={snapshot} />
            {snapshot.done === 0 ? (
              <p className="meta text-center text-slate-green">
                tracking starts as you log — mark milestones as{' '}
                <span data-hale-pii>{firstName(child.name)}</span> reaches them.
              </p>
            ) : (
              <ul className="w-full space-y-1.5">
                {snapshot.domains.map((domain) => (
                  <li key={domain.area} className="flex items-center gap-2 text-sm">
                    <span
                      className="size-2.5 rounded-full shrink-0"
                      style={{ background: `var(--domain-${domain.area})` }}
                    />
                    <span className="flex-1 text-spruce">{domain.label}</span>
                    <span className="meta text-faded-sage tabular">
                      {domain.done}/{domain.total}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Small stack: insight + health summary */}
        <div className="comp-ov-stack">
          <div className="card flex items-start gap-3">
            <span className="shrink-0 grid place-items-center size-9 rounded-[var(--r-md)] bg-lavender text-spruce">
              <Icon as={Sparkles} size={18} />
            </span>
            <div className="min-w-0">
              <span className="eyebrow text-faded-sage">insight</span>
              <p className="text-[0.95rem] text-spruce leading-relaxed mt-1">
                have a question about <span data-hale-pii>{firstName(child.name)}</span>? ask Hale
                for calm, stage-aware guidance.
              </p>
              <Link href="/coach" className="link mt-3 inline-flex items-center gap-1">
                Ask Hale <Icon as={ChevronRight} size={16} />
              </Link>
            </div>
          </div>

          <div className="card">
            <span className="eyebrow text-faded-sage">health summary</span>
            <p className="text-[0.95rem] text-spruce leading-relaxed mt-2" data-hale-pii>
              {child.todayHealth
                ? `${child.todayHealth.what} — ${duePhrase(child.todayHealth.dueInWeeks)}.`
                : 'All good — nothing on the standard schedule right now.'}
            </p>
            <button
              type="button"
              onClick={() => onNavigate('health')}
              className="link mt-3 inline-flex items-center gap-1 cursor-pointer"
            >
              View health records <Icon as={ChevronRight} size={16} />
            </button>
          </div>
        </div>
      </div>

      <CareTeam members={members} viewerEmail={viewerEmail} />
    </div>
  );
}

// ── CARE TEAM & CONTACTS (§4.3) ───────────────────────────────────────────────
//
// The family's REAL caregivers (loadFamilyMembers → primary + co-parent), never a
// fabricated pediatrician. A missing co-parent surfaces the real invite path
// (rule #5: single-parent households work). Provider contacts have no data model yet
// (future item, noted in the PR).

function CareChip({
  name,
  caption,
  isYou,
  icon,
}: {
  name: string;
  caption: string;
  isYou: boolean;
  icon: LucideIcon;
}) {
  return (
    <div className="care-chip">
      <span className="care-chip-avatar">
        <Icon as={icon} size={18} />
      </span>
      <div className="min-w-0">
        <span className="care-chip-name" data-hale-pii>
          {name}
          {isYou ? <span className="care-chip-you">You</span> : null}
        </span>
        <span className="meta text-faded-sage block">{caption}</span>
      </div>
    </div>
  );
}

export function CareTeam({
  members,
  viewerEmail,
}: {
  members: FamilyMembersView;
  viewerEmail: string | null;
}) {
  const { primary, coParent } = members;
  return (
    <div className="card">
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <span className="eyebrow text-faded-sage">care team & contacts</span>
        <Link href="/family" className="link text-sm">
          manage
        </Link>
      </div>
      {primary === null ? (
        <p className="meta text-slate-green">
          your caregivers appear here once your family is set up.
        </p>
      ) : (
        <div className="care-team">
          <CareChip
            name={primary.name ?? 'Primary parent'}
            caption="Primary caregiver"
            isYou={viewerEmail !== null && primary.email === viewerEmail}
            icon={Users}
          />
          {coParent ? (
            <CareChip
              name={coParent.name ?? 'Co-parent'}
              caption="Co-caregiver"
              isYou={viewerEmail !== null && coParent.email === viewerEmail}
              icon={Users}
            />
          ) : (
            <Link href="/family" className="care-chip care-chip-add">
              <span className="care-chip-avatar">
                <Icon as={UserPlus} size={18} />
              </span>
              <div className="min-w-0">
                <span className="care-chip-name">Invite a co-parent</span>
                <span className="meta text-faded-sage block">add their caregiving access</span>
              </div>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// ── HEALTH (§4.3) ─────────────────────────────────────────────────────────────
//
// Next-up visit + immunization windows from the curated Canadian schedule
// (child.nextHealth, derived live from DOB). Booking routes through the approval
// pipeline (BookButton → /api/coach/action), never an inline write. A recently
// passed item surfaces as "was due — done?" rather than vanishing.

export function HealthSection({ child }: { child: ChildCompanionView }) {
  return (
    <div className="space-y-6">
      <div className="card">
        <span className="eyebrow text-faded-sage">next up</span>
        <p className="font-display text-[1.35rem] lg:text-[1.5rem] leading-tight mt-2" data-hale-pii>
          {leadLine(child)}
        </p>
        <p className="meta mt-2 text-slate-green" data-hale-pii>
          {child.whatsNext}
        </p>
        {child.todayHealth ? (
          <p className="meta mt-3 text-slate-green">
            {formatCalendarDate(healthDate(child.dateOfBirth, child.todayHealth.ageMonths))}
          </p>
        ) : null}
      </div>

      {child.recentlyPassedHealth.length > 0 ? (
        <div className="card">
          <span className="eyebrow text-faded-sage">recently passed</span>
          <p className="meta mt-2 text-slate-green">already had these?</p>
          <ul className="mt-4 space-y-4">
            {child.recentlyPassedHealth.map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4 first:border-t-0 first:pt-0"
              >
                <span className="shrink-0 w-32">
                  <span className="eyebrow text-slate-green">{passedAtPhrase(item.ageMonths)}</span>
                </span>
                <span className="text-base text-spruce leading-relaxed" data-hale-pii>
                  {item.what}
                </span>
                <span className="basis-full pl-36">
                  <DoneButton
                    item={{ target: 'health', childId: child.id, what: item.what, healthKey: item.key }}
                    alreadyDone={false}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="card">
        <span className="eyebrow text-faded-sage">health items</span>
        <p className="meta mt-2 text-slate-green">checkups · immunizations</p>
        {child.nextHealth.length === 0 ? (
          <p className="mt-4 text-base text-spruce leading-relaxed">
            nothing on the standard schedule right now.
          </p>
        ) : (
          <ul className="mt-4 space-y-4">
            {child.nextHealth.slice(0, 4).map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-rule pt-4 first:border-t-0 first:pt-0"
              >
                <span className="shrink-0 w-32">
                  {item.dueInWeeks <= 0 ? (
                    <span className="stamp">{duePhrase(item.dueInWeeks)}</span>
                  ) : (
                    <span className="eyebrow text-spruce">{duePhrase(item.dueInWeeks)}</span>
                  )}
                </span>
                <span className="text-base text-spruce leading-relaxed" data-hale-pii>
                  {item.what}
                </span>
                <span className="basis-full pl-36 flex flex-wrap items-center gap-4">
                  {item.done ? null : <BookButton what={item.what} childId={child.id} />}
                  <DoneButton
                    item={{ target: 'health', childId: child.id, what: item.what, healthKey: item.key }}
                    alreadyDone={item.done}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="meta mt-4 text-slate-green">
          standard Canadian schedule — confirm with your provider.
        </p>
      </div>
    </div>
  );
}

// ── GROWTH (§4.3) ─────────────────────────────────────────────────────────────
//
// The measurement series (built client-side from the teen-redacted logs) plus the
// REAL WHO read: an "On track" pill ONLY when the seam computes a typical band, a
// neutral "worth a closer look" note for a review band, and the reading's percentile.
// Non-assessable readings (no sex on file, preterm) carry an honest note — never a
// fabricated verdict.

const TREND_BAR_MAX_H = 64;
const TREND_BAR_MIN_H = 6;

function MiniTrend({ readings, peak }: { readings: { id: string; value: number }[]; peak: number }) {
  const recent = readings.slice(0, 8).reverse();
  return (
    <div className="flex h-[72px] items-end gap-1.5" aria-hidden="true">
      {recent.map((r) => {
        const ratio = peak > 0 ? r.value / peak : 0;
        const height = Math.max(TREND_BAR_MIN_H, Math.round(ratio * TREND_BAR_MAX_H));
        return (
          <span key={r.id} className="flex-1 rounded-[var(--r-sm)] bg-apricot" style={{ height }} />
        );
      })}
    </div>
  );
}

function GrowthBandPill({ stat }: { stat: GrowthHeaderStat | undefined }) {
  if (!stat) return null;
  if (stat.assessment.state === 'assessed') {
    const { band, percentile } = stat.assessment;
    if (band === 'typical') {
      return (
        <span className="pill pill-sage">
          <Icon as={Check} size={13} strokeWidth={2.5} /> On track · {percentileOrdinal(percentile)}{' '}
          %ile
        </span>
      );
    }
    return (
      <span className="pill pill-amber">
        {percentileOrdinal(percentile)} %ile · worth a closer look
      </span>
    );
  }
  if (stat.assessment.state === 'preterm') {
    return <span className="meta text-faded-sage">born early — read against corrected age</span>;
  }
  return <span className="meta text-faded-sage">add birth details for a WHO percentile</span>;
}

function GrowthSeriesCard({
  series,
  stat,
  units,
  timeZone,
}: {
  series: MeasureSeries;
  stat: GrowthHeaderStat | undefined;
  units: UnitSystem;
  timeZone: string;
}) {
  const latest = series.readings[0];
  const latestDisplay = latest ? displayMeasurement(latest.value, series.kind, units) : null;
  return (
    <div className="card space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="eyebrow text-spruce">{series.label}</span>
        {latestDisplay ? (
          <span className="meta text-slate-green" data-hale-pii>
            latest {latestDisplay.value} {latestDisplay.unit}
          </span>
        ) : null}
      </div>

      {series.readings.length === 0 ? (
        <p className="meta text-slate-green">nothing logged for {series.label.toLowerCase()} yet.</p>
      ) : (
        <>
          <GrowthBandPill stat={stat} />
          {series.readings.length >= 2 ? (
            <MiniTrend readings={series.readings} peak={series.peak} />
          ) : null}
          <ul className="space-y-3">
            {series.readings.map((r) => {
              const shown = displayMeasurement(r.value, series.kind, units);
              return (
                <li
                  key={r.id}
                  className="flex items-baseline gap-4 border-t border-rule pt-3 first:border-t-0 first:pt-0"
                >
                  <span className="text-base text-spruce leading-relaxed flex-1" data-hale-pii>
                    {shown.value} {shown.unit}
                  </span>
                  <span className="eyebrow text-faded-sage shrink-0">
                    {formatWhenPhrase(r.occurredAt, timeZone)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function GrowthSection({
  child,
  growthLogs,
  stats,
  units,
  timeZone,
}: {
  child: ChildCompanionView;
  growthLogs: LogView[];
  stats: GrowthHeaderStat[];
  units: UnitSystem;
  timeZone: string;
}) {
  const childLogs = growthLogs.filter((l) => l.childId === child.id);
  const series = buildMeasureSeries(childLogs);
  const byKind = new Map(stats.map((s) => [s.kind, s]));
  const hasAny = series.some((s) => s.readings.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">growth</span>
        <p className="meta mt-2 text-slate-green">measured against the WHO Child Growth Standards</p>
      </div>

      {hasAny ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {series.map((s) => (
            <GrowthSeriesCard
              key={s.kind}
              series={s}
              stat={byKind.get(s.kind)}
              units={units}
              timeZone={timeZone}
            />
          ))}
        </div>
      ) : (
        <div className="panel-oat px-6 py-10 text-center space-y-3">
          <p className="font-display text-[1.35rem] text-spruce">no measurements yet</p>
          <p className="meta text-slate-green max-w-md mx-auto">
            log a weight, height, or head circumference with quick log and a growth record — with
            its WHO percentile — gathers here.
          </p>
        </div>
      )}

      <p className="meta text-slate-green">
        Data source: WHO Child Growth Standards. A percentile is descriptive, not a diagnosis —
        confirm any concern with your provider.
      </p>
    </div>
  );
}

// ── MILESTONES (§4.3) ─────────────────────────────────────────────────────────
//
// The curated per-stage list with a "{done} / {total} this stage" header and
// interactive mark-done (DoneButton → a real audited episode write). Framing stays
// non-diagnostic (rule #1): a not-yet milestone is "worth asking", never "delayed".

export function MilestonesSection({ child }: { child: ChildCompanionView }) {
  const total = child.milestones.length;
  const done = child.milestones.filter((m) => m.done).length;

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <span className="eyebrow">milestones</span>
          <p className="meta mt-2 text-slate-green">most kids, this stage</p>
        </div>
        <span className="stamp tabular">
          {done} / {total} this stage
        </span>
      </div>
      <ul className="space-y-4">
        {child.milestones.map((milestone, idx) => (
          <li
            key={milestone.what}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4 first:border-t-0 first:pt-0"
          >
            <span className="shrink-0 grid place-items-center size-7 rounded-full bg-oat folio">
              {idx + 1}
            </span>
            <span className="shrink-0 text-apricot-deep">
              <Icon as={MILESTONE_AREA_ICON[milestone.area]} size={18} />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-base text-spruce leading-relaxed" data-hale-pii>
                {milestone.what}
              </span>
              <span className="meta text-faded-sage">
                {windowPhrase(milestone.typicalWindowMonths)} · {TIMING_LABEL[milestone.timing]}
              </span>
            </span>
            <span className="shrink-0">
              <DoneButton
                item={{ target: 'milestone', childId: child.id, what: milestone.what }}
                alreadyDone={milestone.done}
              />
            </span>
          </li>
        ))}
      </ul>
      <p className="meta text-slate-green">not happening yet is worth asking about, never a verdict.</p>
    </div>
  );
}

// ── ROUTINES (§4.3) ───────────────────────────────────────────────────────────
//
// HONEST v1, read-only: this week's routine proposal from the village payload
// (already teen-redacted). No editable per-child routine yet (a future migration).

export function RoutinesSection({ routine }: { routine: RoutineProposalView | null }) {
  if (!routine || routine.items.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <span className="eyebrow">routines</span>
          <p className="meta mt-2 text-slate-green">Hale’s weekly rhythm</p>
        </div>
        <div className="panel-oat px-6 py-10 text-center space-y-3">
          <p className="font-display text-[1.35rem] text-spruce">no rhythm yet this week</p>
          <p className="meta text-slate-green max-w-md mx-auto">
            Hale proposes a gentle weekly routine as your village fills in. check back soon.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <span className="eyebrow">routines</span>
        <p className="meta mt-2 text-slate-green">proposed by Hale · week of {routine.weekOf}</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {routine.items.map((item, i) => (
          <div key={`${item.kind}-${i}`} className="card space-y-2">
            {item.teenAttributed ? (
              <>
                <span className="pill pill-berry">private</span>
                <p className="meta text-slate-green">a teen’s item — category only, kept private.</p>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="pill pill-apricot">{item.kind}</span>
                  {item.day ? (
                    <span className="eyebrow text-slate-green capitalize">{item.day}</span>
                  ) : null}
                </div>
                <p className="font-display text-[1.15rem] text-spruce leading-tight" data-hale-pii>
                  {item.title}
                </p>
                {item.stageNote ? (
                  <p className="meta text-slate-green" data-hale-pii>
                    {item.stageNote}
                  </p>
                ) : null}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DOCUMENTS (§4.3) ──────────────────────────────────────────────────────────
//
// The family's REAL Docs vault (listDocuments, teen-redacted), scoped to this child
// and family-wide docs. The bytes never reach the browser — this is the inventory
// (title / kind / size / date). Uploading and opening stay in the Hale app (no web
// vault CRUD yet); an honest note says so.

const DOC_KIND_PILL: Record<string, string> = {
  health: 'pill-sage',
  insurance: 'pill-apricot',
  other: 'pill-sky',
};

export function DocumentsSection({
  documents,
  child,
}: {
  documents: DocumentView[];
  child: ChildCompanionView;
}) {
  const childDocs = documents.filter((d) => d.childId === child.id || d.childId === null);

  return (
    <div className="space-y-5">
      <div>
        <span className="eyebrow">documents</span>
        <p className="meta mt-2 text-slate-green">the family vault</p>
      </div>
      {childDocs.length === 0 ? (
        <div className="panel-oat px-6 py-10 text-center space-y-3">
          <p className="font-display text-[1.35rem] text-spruce">no documents yet</p>
          <p className="meta text-slate-green max-w-md mx-auto">
            health cards, immunization records and insurance live in the family vault. add the first
            one from the Hale app.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {childDocs.map((doc) => (
            <li key={doc.id} className="card flex items-center gap-4 py-4">
              <span className="shrink-0 grid place-items-center size-10 rounded-[var(--r-md)] bg-oat text-slate-green">
                <Icon as={FileText} size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-base text-spruce leading-snug truncate" data-hale-pii>
                  {doc.title}
                </span>
                <span className="meta text-faded-sage">
                  {formatCalendarDate(new Date(doc.createdAt))} · {formatBytes(doc.sizeBytes)}
                </span>
              </span>
              <span className={`pill ${DOC_KIND_PILL[doc.kind] ?? 'pill-sky'} shrink-0 capitalize`}>
                {doc.kind}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="meta text-slate-green">upload and open documents in the Hale app.</p>
    </div>
  );
}

// ── SECTION NAV (§4.3 underline sub-tabs) ─────────────────────────────────────

function SectionNav({
  value,
  onSelect,
  baseId,
}: {
  value: CompanionTabKey;
  onSelect: (s: CompanionTabKey) => void;
  baseId: string;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = COMPANION_TABS.findIndex((s) => s.key === value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(event.key, active, COMPANION_TABS.length);
    if (next === null) return;
    event.preventDefault();
    const tab = COMPANION_TABS[next];
    if (!tab) return;
    onSelect(tab.key);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="companion sections"
      onKeyDown={onKeyDown}
      className="flex flex-row gap-1 overflow-x-auto border-b border-rule -mx-1 px-1"
    >
      {COMPANION_TABS.map((tab, idx) => {
        const isActive = idx === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-sec-tab-${idx}`}
            aria-selected={isActive}
            aria-controls={`${baseId}-sec-panel`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            className={`shrink-0 min-h-[44px] px-3 pb-3 text-sm cursor-pointer touch-manipulation transition-colors border-b-2 -mb-px focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--color-linen),0_0_0_5px_var(--color-apricot-deep)] ${
              isActive
                ? 'border-brand text-spruce font-bold'
                : 'border-transparent text-muted font-medium hover:text-spruce'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ── SECTION PANEL ─────────────────────────────────────────────────────────────

function SectionPanel({
  section,
  child,
  stats,
  routine,
  growthLogs,
  recentLogs,
  documents,
  members,
  viewerEmail,
  units,
  timeZone,
  onNavigate,
}: {
  section: CompanionTabKey;
  child: ChildCompanionView;
  stats: GrowthHeaderStat[];
  routine: RoutineProposalView | null;
  growthLogs: LogView[];
  recentLogs: RecentLogView[];
  documents: DocumentView[];
  members: FamilyMembersView;
  viewerEmail: string | null;
  units: UnitSystem;
  timeZone: string;
  onNavigate: (s: CompanionTabKey) => void;
}) {
  switch (section) {
    case 'overview':
      return (
        <OverviewSection
          child={child}
          recentLogs={recentLogs}
          members={members}
          viewerEmail={viewerEmail}
          timeZone={timeZone}
          onNavigate={onNavigate}
        />
      );
    case 'health':
      return <HealthSection child={child} />;
    case 'growth':
      return (
        <GrowthSection
          child={child}
          growthLogs={growthLogs}
          stats={stats}
          units={units}
          timeZone={timeZone}
        />
      );
    case 'milestones':
      return <MilestonesSection child={child} />;
    case 'routines':
      return <RoutinesSection routine={routine} />;
    case 'documents':
      return <DocumentsSection documents={documents} child={child} />;
  }
}

// ── SHELL ─────────────────────────────────────────────────────────────────────

/**
 * Per-child Companion hub (design handoff §4.3): a child-hub header (identity + real
 * WHO percentiles) atop the six-tab switcher (Overview / Health / Growth /
 * Milestones / Routines / Documents). The active sub-tab rides `?tab=` so deep links
 * and refreshes survive. For 2+ children a roving child tablist selects which child;
 * only the active child's body mounts. The single page hero ("Companion") lives in
 * the shell top bar — this view emits no <h1>/<header>. Teen privacy is upstream:
 * only curated guidance and already-redacted reads reach here, each child-identifying
 * field under [data-hale-pii].
 */
export function CompanionTabs({
  kids,
  routine,
  growthLogs,
  growthByChild,
  recentLogs,
  documents,
  members,
  viewerEmail,
  units,
  timeZone,
  initialTab,
}: {
  kids: ChildCompanionView[];
  routine: RoutineProposalView | null;
  growthLogs: LogView[];
  growthByChild: Record<string, GrowthHeaderStat[]>;
  recentLogs: RecentLogView[];
  documents: DocumentView[];
  members: FamilyMembersView;
  viewerEmail: string | null;
  units: UnitSystem;
  timeZone: string;
  initialTab: CompanionTabKey;
}) {
  const [active, setActive] = useState(0);
  const [section, setSection] = useState<CompanionTabKey>(initialTab);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function selectSection(key: CompanionTabKey) {
    setSection(key);
    writeTabToUrl(key);
  }

  const activeChild = kids[active];
  if (!activeChild) return null;
  const stats = growthByChild[activeChild.id] ?? [];

  const body = (
    <>
      <ChildHubHeader
        child={activeChild}
        stats={stats}
        units={units}
        onViewGrowth={() => selectSection('growth')}
      />
      <SectionNav value={section} onSelect={selectSection} baseId={baseId} />
      <div
        role="tabpanel"
        id={`${baseId}-sec-panel`}
        aria-labelledby={`${baseId}-sec-tab-${COMPANION_TABS.findIndex((s) => s.key === section)}`}
        tabIndex={-1}
      >
        <SectionPanel
          section={section}
          child={activeChild}
          stats={stats}
          routine={routine}
          growthLogs={growthLogs}
          recentLogs={recentLogs}
          documents={documents}
          members={members}
          viewerEmail={viewerEmail}
          units={units}
          timeZone={timeZone}
          onNavigate={selectSection}
        />
      </div>
    </>
  );

  if (kids.length === 1) {
    return <section className="rise rise-2 space-y-8">{body}</section>;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(event.key, active, kids.length);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className="rise rise-2 space-y-8">
      <div
        role="tablist"
        aria-label="children"
        onKeyDown={onKeyDown}
        className="flex max-w-full items-center gap-1 p-1 rounded-[var(--r-full)] bg-oat w-max overflow-x-auto"
      >
        {kids.map((child, idx) => {
          const isActive = idx === active;
          return (
            <button
              key={child.id}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${idx}`}
              aria-selected={isActive}
              aria-controls={`${baseId}-panel-${idx}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(idx)}
              className={`inline-flex shrink-0 min-h-[44px] items-center gap-2 px-4 rounded-[var(--r-full)] text-sm font-semibold cursor-pointer touch-manipulation transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--color-linen),0_0_0_5px_var(--color-apricot-deep)] ${
                isActive ? 'bg-linen text-spruce' : 'text-slate-green hover:text-spruce'
              }`}
            >
              <span data-hale-pii>{child.name ?? 'your child'}</span>
              <span className="meta font-normal">{STAGE_LABEL[child.stage]}</span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${active}`}
        aria-labelledby={`${baseId}-tab-${active}`}
        tabIndex={-1}
      >
        {body}
      </div>
    </section>
  );
}
