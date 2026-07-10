'use client';

import {
  Baby,
  Brain,
  CalendarCheck,
  Check,
  ChevronRight,
  Footprints,
  MessageCircle,
  Moon,
  Sparkles,
  Stethoscope,
  Users,
  Utensils,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { Icon } from '~/components/ui/icon';
import { buildMeasureSeries, type MeasureSeries } from '~/lib/companion/growth-series';
import {
  BOOKING_EPISODE,
  FEED_EPISODE,
  MILESTONE_EPISODE,
  NAP_EPISODE,
} from '~/lib/companion/log-types';
import type { LogView } from '~/lib/companion/logs-view';
import type { ChildCompanionView } from '~/lib/companion/queries';
import type { RecentLogView } from '~/lib/companion/recent-logs';
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

/**
 * The Companion sections, mirroring the mobile section switcher: a horizontal
 * underline-style tab row (the active tab carries a navy underline). Each key
 * selects one section panel — no route change, the page stays "companion" with
 * one child in focus. On a narrow viewport the row scrolls horizontally.
 */
const SECTIONS = [
  { key: 'overview', label: 'overview' },
  { key: 'health', label: 'health' },
  { key: 'growth', label: 'growth' },
  { key: 'milestones', label: 'milestones' },
  { key: 'routines', label: 'routines' },
  { key: 'diary', label: 'diary' },
  { key: 'docs', label: 'docs' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

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

/** "12-18 months" — the typical age window for a milestone, the overview row's
 * subtitle. Years past 24 months so a school-age window doesn't read in the
 * hundreds ("60-84 months" → "5-7 years"). */
function windowPhrase(window: readonly [number, number]): string {
  const [from, to] = window;
  if (to < 24) return `${from}-${to} months`;
  const yearOf = (m: number) => Math.round(m / 12);
  return `${yearOf(from)}-${yearOf(to)} years`;
}

/** The calendar date a health item is scheduled for: the child's date of birth
 * plus the item's scheduled age in months. Derived from the SAME date_of_birth
 * the whole schedule is keyed on — not a stored field — so it can't drift from
 * the age math. `dateOfBirth` is a bare `YYYY-MM-DD`, kept in UTC so the day the
 * parent typed round-trips (formatCalendarDate reads it in UTC too). */
function healthDate(dateOfBirth: string, ageMonths: number): Date {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + ageMonths, d ?? 1));
}

/** "scheduled at 4 months" — the age a passed health item was set for. Warm, not
 * "overdue": a passed checkup is a gentle nudge, never a failing grade. */
function passedAtPhrase(ageMonths: number): string {
  if (ageMonths < 24) return `scheduled at ${ageMonths} ${ageMonths === 1 ? 'month' : 'months'}`;
  const years = Math.floor(ageMonths / 12);
  return `scheduled at ${years} ${years === 1 ? 'year' : 'years'}`;
}

/**
 * The one thing worth leading with. Horizon-gated: only the soonest health item
 * within the horizon (todayHealth) leads — never a checkup years away. With nothing
 * in the horizon, fall back to the standing periodic-visits note.
 */
function leadLine(child: ChildCompanionView): string {
  const soonest = child.todayHealth;
  if (soonest) return `${soonest.what} — ${duePhrase(soonest.dueInWeeks)}.`;
  return 'Nothing on the standard schedule right now — keep up periodic visits.';
}

function firstName(name: string | null): string {
  return name?.trim().split(/\s+/)[0] ?? 'your child';
}

/** The child's first initial for the neutral avatar placeholder — we hold no
 * child photo, so a calm monogram stands in (never a fabricated face). */
function initialOf(name: string | null): string {
  return firstName(name).charAt(0).toUpperCase() || '·';
}

/** "May 12, 2024" — a birth date always carries its year (a life event, not a
 * this-year calendar entry). Read in UTC so the bare `YYYY-MM-DD` the parent
 * typed round-trips, never shifted a day by the viewer's offset. */
function birthDate(dateOfBirth: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateOfBirth}T00:00:00Z`));
}

/** The child header: a neutral monogram avatar, the child's name, and
 * "{age} old · {DOB}". All child-identifying — name, DOB, initial — sits under
 * [data-hale-pii] so session replay masks it (rule #1). */
function ChildHeader({ child }: { child: ChildCompanionView }) {
  return (
    <div className="flex items-center gap-4 mb-8" data-hale-pii>
      <span className="shrink-0 grid place-items-center size-14 rounded-full bg-apricot-tint text-apricot-deep font-display text-[1.5rem]">
        {initialOf(child.name)}
      </span>
      <div className="min-w-0">
        <h2 className="font-display text-[1.5rem] lg:text-[1.75rem] leading-tight truncate">
          {child.name ?? 'your child'}
        </h2>
        <p className="meta mt-1 text-slate-green">
          {agePhrase(child.ageMonths)} old · {birthDate(child.dateOfBirth)}
        </p>
      </div>
    </div>
  );
}

// ── OVERVIEW ────────────────────────────────────────────────────────────────
//
// The default view (mockup panel 2): two cards side by side — MILESTONES and
// HEALTH SCHEDULE — over the same already-loaded, teen-redacted reads the detail
// sections use, then an honest INSIGHT card. Nothing fabricated: milestone rows
// come from child.milestones (what / window / done), health rows from
// child.nextHealth (what / dueInWeeks → duePhrase, date derived from DOB). A teen
// (rule #1) can have both lists empty → each card shows a calm empty state. The
// AI entry is an honest LINK to /coach, never a fabricated per-child insight.

/** A card header: a small-caps section label and a section-switching "see all". */
function OverviewCardHead({
  label,
  onSeeAll,
}: {
  label: string;
  onSeeAll: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 mb-4">
      <span className="eyebrow text-faded-sage">{label}</span>
      <button type="button" onClick={onSeeAll} className="link text-sm cursor-pointer">
        see all
      </button>
    </div>
  );
}

/** The done indicator on a milestone row: a filled navy check when done, an empty
 * navy ring when not. STATIC — the tappable "mark done" lives in the detail
 * Milestones section; this compact overview only reflects state. */
function DoneCircle({ done }: { done: boolean }) {
  return done ? (
    <span
      className="shrink-0 grid place-items-center size-6 rounded-full bg-spruce text-linen"
      aria-label="done"
    >
      <Icon as={Check} size={14} strokeWidth={3} />
    </span>
  ) : (
    <span
      className="shrink-0 size-6 rounded-full border-2 border-rule-strong"
      aria-label="not done"
    />
  );
}

export function OverviewSection({
  child,
  onNavigate,
}: {
  child: ChildCompanionView;
  onNavigate: (s: SectionKey) => void;
}) {
  const milestones = child.milestones.slice(0, 3);
  const health = child.nextHealth.slice(0, 3);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="card">
          <OverviewCardHead label="milestones" onSeeAll={() => onNavigate('milestones')} />
          {milestones.length === 0 ? (
            <p className="meta text-slate-green">no milestones tracked for this stage yet.</p>
          ) : (
            <ul className="space-y-1">
              {milestones.map((m) => (
                <li
                  key={m.what}
                  className="flex items-center gap-3 rounded-[var(--r-md)] px-3 py-3 -mx-3 hover:bg-oat"
                >
                  <span className="shrink-0 grid place-items-center size-9 rounded-[var(--r-md)] bg-apricot-tint text-apricot-deep">
                    <Icon as={MILESTONE_AREA_ICON[m.area]} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[0.95rem] font-semibold text-spruce truncate">
                      {m.what}
                    </span>
                    <span className="meta text-faded-sage">
                      {windowPhrase(m.typicalWindowMonths)}
                    </span>
                  </span>
                  <DoneCircle done={m.done} />
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => onNavigate('milestones')}
            className="link mt-4 inline-flex items-center gap-1 cursor-pointer"
          >
            view all milestones <Icon as={ChevronRight} size={16} />
          </button>
        </div>

        <div className="card">
          <OverviewCardHead label="health schedule" onSeeAll={() => onNavigate('health')} />
          {health.length === 0 ? (
            <p className="meta text-slate-green">
              nothing on the standard schedule right now — keep up periodic visits.
            </p>
          ) : (
            <ul className="space-y-1">
              {health.map((item) => (
                <li key={item.key}>
                  <button
                    type="button"
                    onClick={() => onNavigate('health')}
                    className="flex w-full items-center gap-3 rounded-[var(--r-md)] px-3 py-3 -mx-3 text-left cursor-pointer hover:bg-oat"
                  >
                    <span className="shrink-0 grid place-items-center size-9 rounded-[var(--r-md)] bg-sage-tint text-sage">
                      <Icon as={CalendarCheck} size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[0.95rem] font-semibold text-spruce" data-hale-pii>
                        {item.what}
                      </span>
                      <span className="meta text-faded-sage">
                        {duePhrase(item.dueInWeeks)} · {formatCalendarDate(healthDate(child.dateOfBirth, item.ageMonths))}
                      </span>
                    </span>
                    <span className="shrink-0 text-faded-sage">
                      <Icon as={ChevronRight} size={18} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => onNavigate('health')}
            className="link mt-4 inline-flex items-center gap-1 cursor-pointer"
          >
            view health schedule <Icon as={ChevronRight} size={16} />
          </button>
        </div>
      </div>

      <div className="card flex items-start gap-4">
        <span className="shrink-0 grid place-items-center size-10 rounded-[var(--r-md)] bg-lavender text-spruce">
          <Icon as={Sparkles} size={20} />
        </span>
        <div className="min-w-0">
          <span className="eyebrow text-faded-sage">insight</span>
          <p className="text-base text-spruce leading-relaxed mt-2">
            have a question about <span data-hale-pii>{firstName(child.name)}</span>? ask Hale for
            calm, stage-aware guidance.
          </p>
          <Link href="/coach" className="link mt-4 inline-flex items-center gap-1">
            ask Hale about <span data-hale-pii>{firstName(child.name)}</span>{' '}
            <Icon as={ChevronRight} size={16} />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── HEALTH ──────────────────────────────────────────────────────────────────

export function HealthSection({ child }: { child: ChildCompanionView }) {
  return (
    <div className="space-y-10">
      <div className="space-y-2">
        <span className="eyebrow">what’s next</span>
        <p className="font-display text-[1.35rem] lg:text-[1.6rem] leading-tight" data-hale-pii>
          {leadLine(child)}
        </p>
        <p className="meta text-slate-green" data-hale-pii>
          {child.whatsNext}
        </p>
      </div>

      {child.recentlyPassedHealth.length > 0 ? (
        <div className="border-t border-rule pt-8">
          <span className="eyebrow">recently passed</span>
          <p className="meta mt-2 text-slate-green">already had these?</p>
          <ul className="mt-5 space-y-4">
            {child.recentlyPassedHealth.map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4 first:border-t-0 first:pt-0"
              >
                <span className="shrink-0 w-28">
                  <span className="eyebrow text-slate-green">{passedAtPhrase(item.ageMonths)}</span>
                </span>
                <span className="text-lg text-spruce leading-relaxed" data-hale-pii>
                  {item.what}
                </span>
                <span className="basis-full pl-32">
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

      <div className="border-t border-rule pt-8">
        <span className="eyebrow">health items</span>
        <p className="meta mt-2 text-slate-green">checkups · immunizations</p>
        {child.nextHealth.length === 0 ? (
          <p className="mt-5 text-lg text-spruce leading-relaxed">
            nothing on the standard schedule right now.
          </p>
        ) : (
          <ul className="mt-5 space-y-4">
            {child.nextHealth.slice(0, 3).map((item) => (
              <li
                key={item.key}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-rule pt-4 first:border-t-0 first:pt-0"
              >
                <span className="shrink-0 w-28">
                  {item.dueInWeeks <= 0 ? (
                    <span className="stamp">{duePhrase(item.dueInWeeks)}</span>
                  ) : (
                    <span className="eyebrow text-spruce">{duePhrase(item.dueInWeeks)}</span>
                  )}
                </span>
                <span className="text-lg text-spruce leading-relaxed" data-hale-pii>
                  {item.what}
                </span>
                <span className="basis-full pl-32 flex flex-wrap items-center gap-4">
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

// ── GROWTH ──────────────────────────────────────────────────────────────────
//
// The measurement series, built client-side from the family's teen-redacted
// measurement logs (buildMeasureSeries), filtered to the active child. A plain
// bar mini-trend + the raw readings — NO percentiles or WHO curves.

const TREND_BAR_MAX_H = 64;
const TREND_BAR_MIN_H = 6;

function MiniTrend({ readings, peak }: { readings: { id: string; value: number }[]; peak: number }) {
  // Oldest→newest, scaled to the peak. Apricot is a FILL here (large graphic bars),
  // never text — token-safe.
  const recent = readings.slice(0, 8).reverse();
  return (
    <div className="flex h-[72px] items-end gap-1.5" aria-hidden="true">
      {recent.map((r) => {
        const ratio = peak > 0 ? r.value / peak : 0;
        const height = Math.max(TREND_BAR_MIN_H, Math.round(ratio * TREND_BAR_MAX_H));
        return (
          <span
            key={r.id}
            className="flex-1 rounded-[var(--r-sm)] bg-apricot"
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

function GrowthSeriesCard({
  series,
  timeZone,
}: {
  series: MeasureSeries;
  timeZone: string;
}) {
  return (
    <div className="card space-y-4">
      <div className="flex items-baseline justify-between gap-4">
        <span className="eyebrow text-spruce">{series.label}</span>
        {series.readings.length > 0 && series.unit ? (
          <span className="meta text-slate-green" data-hale-pii>
            latest {series.readings[0]?.value} {series.unit}
          </span>
        ) : null}
      </div>

      {series.readings.length === 0 ? (
        <p className="meta text-slate-green">nothing logged for {series.label.toLowerCase()} yet.</p>
      ) : (
        <>
          {series.readings.length >= 2 ? (
            <MiniTrend readings={series.readings} peak={series.peak} />
          ) : null}
          <ul className="space-y-3">
            {series.readings.map((r) => (
              <li
                key={r.id}
                className="flex items-baseline gap-4 border-t border-rule pt-3 first:border-t-0 first:pt-0"
              >
                <span className="text-lg text-spruce leading-relaxed flex-1" data-hale-pii>
                  {r.value} {r.unit}
                </span>
                <span className="eyebrow text-faded-sage shrink-0">
                  {formatWhenPhrase(r.occurredAt, timeZone)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function GrowthSection({
  child,
  growthLogs,
  timeZone,
}: {
  child: ChildCompanionView;
  growthLogs: LogView[];
  timeZone: string;
}) {
  const childLogs = growthLogs.filter((l) => l.childId === child.id);
  const series = buildMeasureSeries(childLogs);
  const hasAny = series.some((s) => s.readings.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <span className="eyebrow">growth</span>
        <p className="meta mt-2 text-slate-green">a plain record over time</p>
      </div>

      {hasAny ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {series.map((s) => (
            <GrowthSeriesCard key={s.kind} series={s} timeZone={timeZone} />
          ))}
        </div>
      ) : (
        <div className="panel-oat px-6 py-10 text-center space-y-3">
          <p className="font-display text-[1.35rem] text-spruce">no measurements yet</p>
          <p className="meta text-slate-green max-w-md mx-auto">
            log a weight, height, or head circumference with quick log and a simple growth record
            gathers here.
          </p>
        </div>
      )}

      <p className="meta text-slate-green">
        a plain record of growth over time — no percentiles or WHO comparisons. confirm any concern
        with your provider.
      </p>
    </div>
  );
}

// ── MILESTONES ──────────────────────────────────────────────────────────────

export function MilestonesSection({ child }: { child: ChildCompanionView }) {
  return (
    <div className="space-y-5">
      <div>
        <span className="eyebrow">milestones</span>
        <p className="meta mt-2 text-slate-green">most kids, this stage</p>
      </div>
      <ul className="space-y-4">
        {child.milestones.map((milestone) => (
          <li
            key={milestone.what}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4 first:border-t-0 first:pt-0"
          >
            <span className="shrink-0 w-28">
              {milestone.timing === 'in_window' ? (
                <span className="stamp">{TIMING_LABEL[milestone.timing]}</span>
              ) : (
                <span className="eyebrow text-spruce">{TIMING_LABEL[milestone.timing]}</span>
              )}
            </span>
            <span className="text-lg text-spruce leading-relaxed" data-hale-pii>
              {milestone.what}
            </span>
            <span className="basis-full pl-32">
              <DoneButton
                item={{ target: 'milestone', childId: child.id, what: milestone.what }}
                alreadyDone={milestone.done}
              />
            </span>
          </li>
        ))}
      </ul>
      <p className="meta text-slate-green">
        not happening yet is worth asking about, never a verdict.
      </p>
    </div>
  );
}

// ── ROUTINES ────────────────────────────────────────────────────────────────
//
// HONEST v1, read-only: this week's routine proposal from the village payload
// (RoutineProposalView, already teen-redacted at its mapper). NO editing — an
// editable per-child routine needs a future migration (out of scope). Family-wide,
// so it shows regardless of which child is in focus.

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
                <p className="meta text-slate-green">
                  a teen’s item — category only, kept private.
                </p>
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

// ── DIARY ───────────────────────────────────────────────────────────────────
//
// The child's recent logs (feeds · naps · milestones), from the already-loaded,
// teen-redacted recent-logs read, filtered to the active child. The full,
// paginated, editable history lives at /companion/logs — linked, not duplicated.

function DiarySection({
  child,
  recentLogs,
  timeZone,
}: {
  child: ChildCompanionView;
  recentLogs: RecentLogView[];
  timeZone: string;
}) {
  const childLogs = recentLogs.filter((l) => l.childId === child.id);

  return (
    <div className="space-y-5">
      <div>
        <span className="eyebrow">diary</span>
        <p className="meta mt-2 text-slate-green">feeds · naps · milestones</p>
      </div>
      {childLogs.length === 0 ? (
        <p className="text-lg text-spruce leading-relaxed">
          nothing logged for <span data-hale-pii>{child.name ?? 'your child'}</span> yet — note a
          feed, a nap, or a milestone with quick log and it gathers here.
        </p>
      ) : (
        <ul className="space-y-4">
          {childLogs.map((log) => (
            <li
              key={log.id}
              className="flex items-baseline gap-4 border-t border-rule pt-4 first:border-t-0 first:pt-0"
            >
              <span className="shrink-0 text-apricot-deep">
                <Icon as={LOG_ICON[log.episodeType] ?? CalendarCheck} size={18} />
              </span>
              <span className="text-lg text-spruce leading-relaxed flex-1" data-hale-pii>
                {log.summary}
              </span>
              <span className="eyebrow text-faded-sage shrink-0">
                {formatWhenPhrase(log.occurredAt, timeZone)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link href="/companion/logs" className="link inline-block">
        see every log →
      </Link>
    </div>
  );
}

// ── DOCS ────────────────────────────────────────────────────────────────────
//
// The document vault is a Hale-app feature with no web surface yet. Rather than
// fake a vault the web can't back, this is an honest signpost — never a fabricated
// list.

function DocsSection() {
  return (
    <div className="space-y-5">
      <div>
        <span className="eyebrow">docs</span>
        <p className="meta mt-2 text-slate-green">the family vault</p>
      </div>
      <div className="panel-oat px-6 py-10 text-center space-y-3">
        <p className="font-display text-[1.35rem] text-spruce">the vault lives in the Hale app</p>
        <p className="meta text-slate-green max-w-md mx-auto">
          keeping records, letters, and forms in one place is coming to the web. for now, the
          document vault is on the Hale mobile app.
        </p>
      </div>
    </div>
  );
}

// ── SECTION NAV ─────────────────────────────────────────────────────────────

function SectionNav({
  value,
  onSelect,
  baseId,
}: {
  value: SectionKey;
  onSelect: (s: SectionKey) => void;
  baseId: string;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = SECTIONS.findIndex((s) => s.key === value);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(event.key, active, SECTIONS.length);
    if (next === null) return;
    event.preventDefault();
    const section = SECTIONS[next];
    if (!section) return;
    onSelect(section.key);
    tabRefs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="companion sections"
      onKeyDown={onKeyDown}
      className="flex flex-row gap-1 overflow-x-auto border-b border-rule -mx-1 px-1"
    >
      {SECTIONS.map((section, idx) => {
        const isActive = idx === active;
        return (
          <button
            key={section.key}
            ref={(el) => {
              tabRefs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-sec-tab-${idx}`}
            aria-selected={isActive}
            aria-controls={`${baseId}-sec-panel`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onSelect(section.key)}
            className={`shrink-0 min-h-[44px] px-3 pb-3 text-sm font-semibold capitalize cursor-pointer touch-manipulation transition-colors border-b-2 -mb-px focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_var(--color-linen),0_0_0_5px_var(--color-apricot-deep)] ${
              isActive
                ? 'border-spruce text-spruce'
                : 'border-transparent text-slate-green hover:text-spruce'
            }`}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}

// ── PER-CHILD BODY ──────────────────────────────────────────────────────────

function ChildBody({
  child,
  routine,
  growthLogs,
  recentLogs,
  timeZone,
}: {
  child: ChildCompanionView;
  routine: RoutineProposalView | null;
  growthLogs: LogView[];
  recentLogs: RecentLogView[];
  timeZone: string;
}) {
  const [section, setSection] = useState<SectionKey>('overview');
  const baseId = useId();

  return (
    <div className="space-y-8">
      <SectionNav value={section} onSelect={setSection} baseId={baseId} />
      <div
        role="tabpanel"
        id={`${baseId}-sec-panel`}
        aria-labelledby={`${baseId}-sec-tab-${SECTIONS.findIndex((s) => s.key === section)}`}
        tabIndex={-1}
      >
        {section === 'overview' ? (
          <OverviewSection child={child} onNavigate={setSection} />
        ) : null}
        {section === 'health' ? <HealthSection child={child} /> : null}
        {section === 'growth' ? (
          <GrowthSection child={child} growthLogs={growthLogs} timeZone={timeZone} />
        ) : null}
        {section === 'milestones' ? <MilestonesSection child={child} /> : null}
        {section === 'routines' ? <RoutinesSection routine={routine} /> : null}
        {section === 'diary' ? (
          <DiarySection child={child} recentLogs={recentLogs} timeZone={timeZone} />
        ) : null}
        {section === 'docs' ? <DocsSection /> : null}
      </div>
    </div>
  );
}

// ── SHELL ───────────────────────────────────────────────────────────────────

/**
 * Per-child companion, parity with the mobile Companion tab: a child header (a
 * plain heading for one child, an accessible roving tablist for two or more) atop a
 * six-section switcher (health / growth / milestones / routines / diary / docs).
 * Only the active child's body is mounted. The teen-privacy posture is upstream —
 * this view only shows curated guidance and already-redacted reads, and every
 * child-identifying field stays inside a [data-hale-pii] subtree so session replay
 * masks it.
 */
export function CompanionTabs({
  kids,
  routine,
  growthLogs,
  recentLogs,
  timeZone,
}: {
  kids: ChildCompanionView[];
  routine: RoutineProposalView | null;
  growthLogs: LogView[];
  recentLogs: RecentLogView[];
  timeZone: string;
}) {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const only = kids.length === 1 ? kids[0] : undefined;
  if (only) {
    return (
      <section className="rise rise-2">
        <ChildHeader child={only} />
        <ChildBody
          child={only}
          routine={routine}
          growthLogs={growthLogs}
          recentLogs={recentLogs}
          timeZone={timeZone}
        />
      </section>
    );
  }

  const activeChild = kids[active];
  if (!activeChild) return null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextTabIndex(event.key, active, kids.length);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className="rise rise-2">
      {/* The oat pill sizes to its tabs but can't exceed the column; on a narrow
          phone three-plus children scroll horizontally inside it rather than
          overflowing the viewport. */}
      <div
        role="tablist"
        aria-label="children"
        onKeyDown={onKeyDown}
        className="flex max-w-full items-center gap-1 p-1 rounded-[var(--r-full)] bg-oat mb-8 w-max overflow-x-auto"
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
        <ChildHeader child={activeChild} />
        <ChildBody
          child={activeChild}
          routine={routine}
          growthLogs={growthLogs}
          recentLogs={recentLogs}
          timeZone={timeZone}
        />
      </div>
    </section>
  );
}
