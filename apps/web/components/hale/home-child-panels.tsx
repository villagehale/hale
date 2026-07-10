'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { BookButton } from '~/components/hale/book-button';
import type { StatCell } from '~/lib/home/greeting';

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
 * The selected-child Home columns: "today's snapshot" (col 1) and "up next" (top
 * of col 2), sharing one active-child selection. A segmented control switches the
 * active child when the family has more than one; a single child renders no
 * control. Stats are family-wide (not per child), so they stay fixed as the
 * selection changes. `villageSlot` is the server-rendered "from your village" card
 * that sits under Up next in the same column.
 */
export function HomeChildPanels({
  kids,
  statCells,
  villageSlot,
}: {
  kids: HomeChildSnapshot[];
  statCells: StatCell[];
  villageSlot: ReactNode;
}) {
  const [activeId, setActiveId] = useState(kids[0]?.id ?? '');
  const active = kids.find((c) => c.id === activeId) ?? kids[0];
  if (!active) return null;

  return (
    <>
      <div className="rise rise-3 flex flex-col gap-8">
        <div>
          <p className="eyebrow mb-3 text-faded-sage">today&rsquo;s snapshot</p>
          <div className="card">
            {kids.length > 1 ? (
              <div
                className="mb-4 flex flex-wrap gap-1 rounded-full bg-linen p-1"
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
                    className={`min-h-9 flex-1 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${
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

            <Link href="/companion" className="link mt-4 inline-block">
              view all insights &rarr;
            </Link>
          </div>
        </div>
      </div>

      <div className="rise rise-4 flex flex-col gap-8">
        <div>
          <p className="eyebrow mb-3 text-faded-sage">up next</p>
          <div className="card">
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

        {villageSlot}
      </div>
    </>
  );
}
