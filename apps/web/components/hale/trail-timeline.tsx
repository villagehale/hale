'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { TrailView } from '~/lib/dashboard/mappers';
import { trailToCsv } from '~/lib/trail/csv';
import { ChildTag } from '~/components/hale/child-tag';
import { ToneLabel } from '~/components/hale/tone';

const ACTOR_LABEL: Record<TrailView['actor'], string> = {
  hale: 'Hale',
  you: 'you',
  'co-parent': 'co-parent',
};

const ACTOR_TONE: Record<TrailView['actor'], string> = {
  hale: 'text-apricot-deep',
  you: 'text-spruce',
  'co-parent': 'text-sky-deep',
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
  rows: TrailView[];
}

/** Buckets the (already time-ordered) rows into contiguous day groups by dayKey,
 * preserving order — so the timeline reads as dated sections, each headed by its
 * full day, rather than a flat wall of times. */
function groupByDay(rows: TrailView[]): TrailDay[] {
  const days: TrailDay[] = [];
  for (const row of rows) {
    const last = days[days.length - 1];
    if (last?.key === row.dayKey) {
      last.rows.push(row);
    } else {
      days.push({ key: row.dayKey, date: row.date, rows: [row] });
    }
  }
  return days;
}

/**
 * The History timeline with its working filter + CSV export. The server page
 * loads the (teen-redacted) rows and hands them in; this owns the client-side
 * view: the filter narrows the list in place, and the export downloads exactly
 * the rows currently shown (rule #1 — the CSV can carry nothing the page can't).
 */
export function TrailTimeline({ entries }: { entries: TrailView[] }) {
  const [filter, setFilter] = useState<Filter>('all');

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
          <p className="font-display text-[1.5rem] lg:text-[1.875rem] text-spruce">
            nothing matches this view.
          </p>
          <p className="meta mt-4 text-slate-green">try a different filter above.</p>
        </section>
      ) : (
        <div>
          {days.map((day, dayIdx) => (
            <section key={day.key} className={`rise rise-${Math.min(dayIdx + 4, 7)} mt-10 first:mt-2`}>
              <h2 className="eyebrow sticky top-0 bg-linen py-3 border-b border-rule z-10">
                {day.date}
              </h2>
              {day.rows.map((entry) => (
                <article
                  key={entry.id}
                  className="py-8 lg:py-10 border-b border-rule last:border-b-0"
                >
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-y-3 md:gap-x-8">
                    <div className="md:col-span-2">
                      <p className="meta tabular">{entry.time}</p>
                    </div>
                    <div className="md:col-span-2">
                      <span className={`eyebrow ${ACTOR_TONE[entry.actor]}`}>
                        {ACTOR_LABEL[entry.actor]}
                      </span>
                      <p className="meta mt-1">{entry.noun}</p>
                    </div>
                    <div className="md:col-span-8">
                      <ToneLabel tone={entry.tone} />
                      <div data-hale-pii>
                        <p className="mt-3 text-lg text-spruce leading-relaxed">{entry.summary}</p>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                        {entry.childLabel !== null ? (
                          <ChildTag childId="child" label={entry.childLabel} />
                        ) : null}
                        {entry.link !== null ? (
                          <Link href={entry.link} className="btn-ghost">
                            view this {entry.noun}
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}
