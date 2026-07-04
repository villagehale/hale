'use client';

import Link from 'next/link';
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import type { ChildCompanionView } from '~/lib/companion/queries';
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

/** "was due at 4 months" — the age a passed health item was scheduled for. */
function passedAtPhrase(ageMonths: number): string {
  if (ageMonths < 24) return `was due at ${ageMonths} ${ageMonths === 1 ? 'month' : 'months'}`;
  const years = Math.floor(ageMonths / 12);
  return `was due at ${years} ${years === 1 ? 'year' : 'years'}`;
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

function ChildPanel({ child }: { child: ChildCompanionView }) {
  return (
    <div className="space-y-10">
      {/* Lead — what's next, up front */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-12">
        <div className="lg:col-span-3">
          <span className="eyebrow">what’s next</span>
        </div>
        <div className="lg:col-span-9 space-y-2">
          <p className="font-display text-[1.35rem] lg:text-[1.6rem] leading-tight" data-hale-pii>
            {leadLine(child)}
          </p>
          <p className="meta text-slate-green" data-hale-pii>
            {child.whatsNext}
          </p>
        </div>
      </div>

      {/* Recently passed — surfaced, not silently dropped */}
      {child.recentlyPassedHealth.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-12 border-t border-rule pt-8">
          <div className="lg:col-span-3">
            <span className="eyebrow">recently passed</span>
            <p className="meta mt-2 text-slate-green">already had these?</p>
          </div>
          <div className="lg:col-span-9">
            <ul className="space-y-4">
              {child.recentlyPassedHealth.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-wrap items-baseline gap-x-4 gap-y-2 border-t border-rule pt-4 first:border-t-0 first:pt-0"
                >
                  <span className="shrink-0 w-28">
                    <span className="eyebrow text-slate-green">
                      {passedAtPhrase(item.ageMonths)}
                    </span>
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
        </div>
      ) : null}

      {/* Next health items */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-12 border-t border-rule pt-8">
        <div className="lg:col-span-3">
          <span className="eyebrow">health items</span>
          <p className="meta mt-2 text-slate-green">checkups · immunizations</p>
        </div>
        <div className="lg:col-span-9">
          {child.nextHealth.length === 0 ? (
            <p className="text-lg text-spruce leading-relaxed">
              nothing on the standard schedule right now.
            </p>
          ) : (
            <ul className="space-y-4">
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

      {/* Milestones */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-12 border-t border-rule pt-8">
        <div className="lg:col-span-3">
          <span className="eyebrow">milestones</span>
          <p className="meta mt-2 text-slate-green">most kids, this stage</p>
        </div>
        <div className="lg:col-span-9">
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
          <p className="meta mt-4 text-slate-green">
            not happening yet is worth asking about, never a verdict.
          </p>
        </div>
      </div>

      {/* What matters now */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-3 lg:gap-x-12 border-t border-rule pt-8">
        <div className="lg:col-span-3">
          <span className="eyebrow">worth doing now</span>
        </div>
        <div className="lg:col-span-9 space-y-5">
          <ul className="space-y-3" data-hale-pii>
            {child.whatsNow.map((point) => (
              <li key={point} className="text-lg text-spruce leading-relaxed">
                {point}
              </li>
            ))}
          </ul>
          <Link href={`/coach?child=${child.id}`} className="btn-ghost">
            ask Hale about <span data-hale-pii>{child.name ?? 'your child'}</span> →
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Per-child companion. One child renders its panel directly; two or more render an
 * accessible segmented tablist (roving tabindex, arrow/Home/End keys, aria-selected)
 * so only the active child's panel is on screen — no stacked scroll. Selection is
 * local component state, defaulting to the first child. The teen-privacy posture is
 * upstream: this view only ever shows curated, non-diagnostic guidance derived from
 * date of birth, and every child-identifying field stays inside a [data-hale-pii]
 * subtree so session replay masks it.
 */
export function CompanionTabs({ kids }: { kids: ChildCompanionView[] }) {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const only = kids.length === 1 ? kids[0] : undefined;
  if (only) {
    return (
      <section className="rise rise-2">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-y-4 lg:gap-x-12 border-b border-rule pb-6 mb-8">
          <div className="lg:col-span-3">
            <span className="stamp inline-block">{STAGE_LABEL[only.stage]}</span>
          </div>
          <div className="lg:col-span-9" data-hale-pii>
            <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
              {only.name ?? 'your child'}
            </h2>
            <p className="meta mt-2 text-slate-green">{agePhrase(only.ageMonths)} old</p>
          </div>
        </div>
        <ChildPanel child={only} />
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
        <div className="border-b border-rule pb-6 mb-8" data-hale-pii>
          <h2 className="font-display text-[1.75rem] lg:text-[2.25rem] leading-tight">
            {activeChild.name ?? 'your child'}
          </h2>
          <p className="meta mt-2 text-slate-green">{agePhrase(activeChild.ageMonths)} old</p>
        </div>
        <ChildPanel child={activeChild} />
      </div>
    </section>
  );
}
