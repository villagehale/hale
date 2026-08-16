'use client';

import { ChevronRight, RotateCcw, Shield, Sparkles, User, Users, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { TrailView } from '~/lib/dashboard/mappers';
import { trailToCsv } from '~/lib/trail/csv';
import { type TrailItem, groupIntoTraces, trailItemKey } from '~/lib/trail/traces';
import { ChildTag } from '~/components/hale/child-tag';
import { ToneLabel, ToneStripe } from '~/components/hale/tone';
import { type ChipTone, TintChip } from '~/components/ui/tint-chip';

const ACTOR_LABEL: Record<TrailView['actor'], string> = {
  hale: 'Hale',
  you: 'you',
  'co-parent': 'co-parent',
};

/**
 * Who did it, as a Shore tint chip. The three actors used to be told apart by
 * text colour alone — and two of the three tones (`apricot-deep` and `spruce`)
 * are the SAME ink navy since W1 re-pointed the accent, so the distinction was
 * invisible. The glyph carries it now, as the design system requires anyway
 * (colour is never the sole carrier); the label beside it stays plain ink.
 */
const ACTOR_CHIP: Record<TrailView['actor'], { as: LucideIcon; tone: ChipTone }> = {
  hale: { as: Sparkles, tone: 'blue' },
  you: { as: User, tone: 'gray' },
  'co-parent': { as: Users, tone: 'teal' },
};

type Filter = 'all' | 'hale' | 'parent';

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'all' },
  { value: 'hale', label: 'Hale only' },
  { value: 'parent', label: 'parent decisions' },
];

function matchesFilter(entry: TrailView, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'hale') return entry.actor === 'hale';
  return entry.actor !== 'hale';
}

interface TrailDay {
  key: string;
  date: string;
  /** The day's rows with each action's several steps folded into one lifecycle. */
  items: TrailItem[];
}

/** Buckets the (already time-ordered) rows into contiguous day groups by dayKey,
 * preserving order — so the timeline reads as dated sections, each headed by its
 * full day, rather than a flat wall of times. Each day's rows are then folded into
 * lifecycles (traces.ts), which is why the grouping is per-day and not global. */
function groupByDay(rows: TrailView[]): TrailDay[] {
  const days: Array<{ key: string; date: string; rows: TrailView[] }> = [];
  for (const row of rows) {
    const last = days[days.length - 1];
    if (last?.key === row.dayKey) {
      last.rows.push(row);
    } else {
      days.push({ key: row.dayKey, date: row.date, rows: [row] });
    }
  }
  return days.map((day) => ({ key: day.key, date: day.date, items: groupIntoTraces(day.rows) }));
}

/** The teen-privacy mark and the child tag, shared by the full row and a trace step. */
function RowMarks({ entry }: { entry: TrailView }) {
  return (
    <>
      {/* Rule #1 made visible rather than merely obeyed: the row already
        * carries the placeholder instead of the sentence, and this says
        * WHY in the same calm wash Approvals uses for the same fact. */}
      {entry.teenRedacted ? (
        <span className="pill pill-berry inline-flex items-center gap-1.5">
          <Shield size={13} strokeWidth={1.8} aria-hidden="true" />
          teen privacy
        </span>
      ) : null}
      {/* The trail carries the child's LABEL, not their id, so there is
        * nothing here to derive a per-child tint from — the neutral gray
        * keeps the invariant that a tint always names one known kid. */}
      {entry.childLabel !== null ? (
        <ChildTag childId="child" label={entry.childLabel} tone="gray" />
      ) : null}
    </>
  );
}

/** A standalone entry — one audit row that is the whole of what happened. */
function TrailRow({ entry }: { entry: TrailView }) {
  return (
    // VIL-244 · M9: the row's audit_log id is its anchor, so an outbound
    // channel message can deep-link the exact receipt (`/trail#<id>`).
    // scroll-mt clears the sticky day heading above it.
    <article id={entry.id} className="scroll-mt-24 py-8 lg:py-10 border-b border-rule last:border-b-0">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
        <div className="md:col-span-2">
          <p className="meta tabular text-ink-3">{entry.time}</p>
        </div>
        <div className="md:col-span-3 flex items-start gap-3">
          <TintChip {...ACTOR_CHIP[entry.actor]} />
          <div className="min-w-0">
            <span className="eyebrow">{ACTOR_LABEL[entry.actor]}</span>
            <p className="meta mt-1 text-ink-3">{entry.noun}</p>
          </div>
        </div>
        <div className="md:col-span-7">
          <ToneLabel tone={entry.tone} />
          <div data-hale-pii>
            <p className="mt-3 text-lg text-ink leading-relaxed">{entry.summary}</p>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <RowMarks entry={entry} />
            {entry.link !== null ? (
              <Link href={entry.link} className="btn-ghost">
                view this {entry.noun}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * One action's lifecycle, collapsed to where it got to. Native `<details>` so it
 * works without JavaScript and reads as one disclosure to a screen reader — the same
 * pattern the approval card's "view what Hale drafted" already uses.
 *
 * The steps read FORWARD inside (the query hands them newest-first, because that is
 * how the timeline is ordered), so the summary answers "where did this end up" and
 * the body answers "how did it get there".
 */
function TrailTrace({ actionId, rows }: { actionId: string; rows: TrailView[] }) {
  const latest = rows[0];
  const steps = [...rows].reverse();
  if (!latest) return null;
  return (
    <details id={actionId} className="scroll-mt-24 border-b border-rule last:border-b-0">
      <summary className="trace-summary">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
          <div className="md:col-span-2 flex items-center gap-1.5">
            {/* The native marker sits outside the summary's box, which would put it
              * outside the focus ring and off the timeline's own grid. This one rides
              * the time column, so a trace lines up with the rows around it. */}
            <ChevronRight className="trace-caret" size={14} strokeWidth={2} aria-hidden="true" />
            <p className="meta tabular text-ink-3">{latest.time}</p>
          </div>
          <div className="md:col-span-3 flex items-start gap-3">
            <TintChip {...ACTOR_CHIP[latest.actor]} />
            <div className="min-w-0">
              <span className="eyebrow">{ACTOR_LABEL[latest.actor]}</span>
              <p className="meta mt-1 text-ink-3">{latest.noun}</p>
            </div>
          </div>
          <div className="md:col-span-7">
            <ToneLabel tone={latest.tone} />
            <div data-hale-pii>
              <p className="mt-3 text-lg text-ink leading-relaxed">{latest.summary}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
              <RowMarks entry={latest} />
              <span className="eyebrow">{rows.length} steps on this one</span>
            </div>
          </div>
        </div>
      </summary>
      <ol className="trace-steps">
        {steps.map((step) => (
          // Each step keeps its own audit_log anchor, so the M9 deep links that
          // point INTO a lifecycle still resolve (the effect above opens the
          // disclosure they landed in).
          <li key={step.id} id={step.id} className="trace-step scroll-mt-24">
            <span className="meta tabular text-ink-3">{step.time}</span>
            <span className="eyebrow">{ACTOR_LABEL[step.actor]}</span>
            <span className="flex items-start gap-2">
              <span className="mt-1">
                <ToneStripe tone={step.tone} />
              </span>
              <span className="min-w-0">
                <span className="block text-ink leading-relaxed" data-hale-pii>
                  {step.summary}
                </span>
                {step.reversalKept ? (
                  <span className="meta mt-1 inline-flex items-center gap-1.5 text-ink-3">
                    <RotateCcw size={13} strokeWidth={1.8} aria-hidden="true" />
                    Hale kept a way to take this back
                  </span>
                ) : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function TimelineItem({ item }: { item: TrailItem }) {
  if (item.kind === 'single') return <TrailRow entry={item.row} />;
  return <TrailTrace actionId={item.actionId} rows={item.rows} />;
}

/**
 * The History timeline with its working filter + CSV export. The server page
 * loads the (teen-redacted) rows and hands them in; this owns the client-side
 * view: the filter narrows the list in place, and the export downloads exactly
 * the rows currently shown (rule #1 — the CSV can carry nothing the page can't).
 */
export function TrailTimeline({ entries }: { entries: TrailView[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  /**
   * A row inside a collapsed trace is not scrolled to by the browser, so the M9
   * deep links (`/trail#<audit-id>`) would have silently stopped landing the day
   * lifecycles started collapsing. Open the disclosure the target sits in, then
   * scroll to it ourselves. Runs once on mount, which is when the hash arrives.
   */
  useEffect(() => {
    const targetId = window.location.hash.slice(1);
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target) return;
    target.closest('details')?.setAttribute('open', '');
    target.scrollIntoView({ block: 'start' });
  }, []);

  const visible = useMemo(
    () => entries.filter((entry) => matchesFilter(entry, filter)),
    [entries, filter],
  );
  const days = useMemo(() => groupByDay(visible), [visible]);

  function exportCsv(): void {
    const blob = new Blob([trailToCsv(visible)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `hale-history-${filter}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <section className="rise rise-3 flex flex-wrap items-baseline gap-x-5 gap-y-3 border-b border-rule pb-5 mb-2">
        <span className="eyebrow">show</span>
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="btn-ghost"
            aria-pressed={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
        <span className="ml-auto">
          <button
            type="button"
            className="btn-ghost"
            onClick={exportCsv}
            disabled={visible.length === 0}
          >
            export csv
          </button>
        </span>
      </section>

      {visible.length === 0 ? (
        <section className="rise rise-4 panel-oat px-6 py-12 lg:py-16 text-center">
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-ink">
            nothing matches this view.
          </p>
          <p className="meta mt-4 text-ink-2">try a different filter above.</p>
        </section>
      ) : (
        <div>
          {days.map((day, dayIdx) => (
            <section key={day.key} className={`rise rise-${Math.min(dayIdx + 4, 7)} mt-10 first:mt-2`}>
              <h2 className="eyebrow sticky top-0 bg-canvas py-3 border-b border-rule z-10">
                {day.date}
              </h2>
              {day.items.map((item) => (
                <TimelineItem key={trailItemKey(item)} item={item} />
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
