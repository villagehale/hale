'use client';

import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { BookButton } from '~/components/hale/book-button';
import { HomeChildRow2 } from '~/components/hale/home-child-row2';
import type { StatCell } from '~/lib/home/greeting';
import { type HomeChildDays, formatDurationMinutes } from '~/lib/home/child-days';

/** One child's Home snapshot slice — everything the selected-child panels render,
 * pre-derived server-side (rule #1 redaction already applied upstream). The health
 * item is the child's `todayHealth` flattened to what the "up next" card shows. */
export interface HomeChildSnapshot {
  id: string;
  name: string;
  stageLabel: string;
  upNext: { what: string; duePhrase: string } | null;
}

/**
 * The selected-child Home surface: it owns the single active-child selection and
 * renders BOTH rows of the design handoff §4.2 dashboard so the snapshot ("today's
 * snapshot" + "this week"), "up next", and Row 2 (today's highlights / sleep / meals)
 * all follow the SAME child. A segmented control switches the active child when the
 * family has more than one; a single child renders no control. The family-wide Row-1
 * cards — the quick-links tile grid and "from your village" — are server-rendered and
 * passed in as slots so they sit in the Row-1 grid without re-rendering on selection.
 * Stats are family-wide and stay fixed as the selection changes; Row 2 + "this week"
 * are per active child.
 */
export function HomeChildPanels({
  kids,
  statCells,
  daysByChild,
  quickLinks,
  villagePick,
}: {
  kids: HomeChildSnapshot[];
  statCells: StatCell[];
  daysByChild: Record<string, HomeChildDays>;
  quickLinks: ReactNode;
  villagePick: ReactNode;
}) {
  const [activeId, setActiveId] = useState(kids[0]?.id ?? '');
  const active = kids.find((c) => c.id === activeId) ?? kids[0];
  if (!active) return null;
  const days = daysByChild[active.id];

  return (
    <>
      <div className="home-row1">
        <div className="rise rise-3 home-col">
          <p className="eyebrow text-faded-sage">today&rsquo;s snapshot</p>
          <div className="card home-card-fill">
            {kids.length > 1 ? (
              <div
                className="mb-4 flex flex-wrap justify-center gap-1 rounded-full bg-linen p-1"
                role="tablist"
                aria-label="choose child"
              >
                {kids.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    role="tab"
                    aria-selected={child.id === active.id}
                    onClick={() => setActiveId(child.id)}
                    className={`min-h-9 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${
                      child.id === active.id
                        ? 'bg-oat text-spruce shadow-sm'
                        : 'text-slate-green hover:text-spruce'
                    }`}
                    data-hale-pii
                  >
                    {child.name}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="border-b border-rule pb-4">
              <h2 className="font-display text-[1.25rem] leading-tight text-spruce" data-hale-pii>
                {active.name}
              </h2>
              <p className="meta mt-0.5 text-faded-sage">{active.stageLabel}</p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              {statCells.map((cell) => (
                <div key={cell.label} className="min-w-0">
                  {cell.count === null ? (
                    <p className="meta leading-snug text-faded-sage">{cell.label}</p>
                  ) : (
                    <>
                      <p className="tabular font-display text-[1.5rem] leading-none text-spruce">
                        {cell.count}
                      </p>
                      <p className="meta mt-1 leading-snug text-faded-sage">{cell.label}</p>
                    </>
                  )}
                </div>
              ))}
            </div>

            {days ? <ThisWeek days={days} /> : null}

            <Link href="/companion" className="link mt-4 inline-block">
              view all insights &rarr;
            </Link>
          </div>
        </div>

        <div className="rise rise-4 home-col">
          <p className="eyebrow text-faded-sage">up next</p>
          <div className="card home-card-fill">
            {active.upNext ? (
              <>
                <span className="eyebrow text-apricot-deep">{active.upNext.duePhrase}</span>
                <p
                  className="mt-2 font-display text-[1.15rem] leading-snug text-spruce"
                  data-hale-pii
                >
                  {active.upNext.what}
                </p>
                <p className="meta mt-1 text-slate-green" data-hale-pii>
                  for {active.name}
                </p>
                <div className="mt-3">
                  <BookButton what={active.upNext.what} childId={active.id} />
                </div>
              </>
            ) : (
              <p className="text-spruce leading-relaxed">
                nothing scheduled soon for <span data-hale-pii>{active.name}</span> — you&rsquo;re
                all caught up.
              </p>
            )}
          </div>
        </div>

        {quickLinks}
        {villagePick}
      </div>

      {days ? <HomeChildRow2 day={days} childName={active.name} /> : null}
    </>
  );
}

/**
 * The "this week" summary rows in the snapshot card — only rows with a REAL source
 * (avg logged sleep, milestone count). A row with no backing data is OMITTED, never
 * shown as a fabricated figure (the prototype's "longest stretch 12h 20m" has no
 * source and is dropped). The whole block is absent when nothing this week is
 * computable.
 */
function ThisWeek({ days }: { days: HomeChildDays }) {
  const rows: Array<{ label: string; value: string }> = [];
  if (days.avgSleepMin !== null) {
    rows.push({ label: 'avg sleep', value: formatDurationMinutes(days.avgSleepMin) });
  }
  if (days.milestonesThisWeek > 0) {
    rows.push({
      label: 'milestones',
      value: `${days.milestonesThisWeek} this week`,
    });
  }
  if (rows.length === 0) return null;

  return (
    <div className="mt-4 border-t border-rule pt-4">
      <p className="eyebrow text-faded-sage">this week</p>
      <dl className="mt-2 flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3">
            <dt className="meta text-slate-green">{row.label}</dt>
            <dd className="tabular text-spruce">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
