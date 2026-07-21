import type { WeekPlan, WeekPlanItem } from '@hale/db';
import { formatCalendarDate } from '~/lib/format/datetime';
import { WEEKDAYS, weekdayIndexIn } from '~/lib/plan/spine';

/**
 * The in-app receipt for B1's composed week (VIL-218 · B2 parity). Renders the
 * SAME persisted `week_plans` artifact the Sunday text sends — never a re-derived
 * live view — so the two can't disagree.
 *
 * Design pass (two-rubric, 2026-07-21): the receipt mirrors the Sunday email's
 * language on the app surface — the summary is the serif *signature* (Source Serif 4,
 * the app display face), and the plan is split into a "needs your OK" region (the
 * decisions, in the warm wash) above a quiet "on your calendar" list (what's handled),
 * rather than one undifferentiated grid of identical cards. Provenance rides as a
 * quiet caption, not a loud pill. The app palette has no amber (its accent is navy +
 * warm-neutral washes), so the decision region uses the warm wash, not amber.
 *
 * This is the account holder's own private surface: item titles are shown as-is.
 * They were already teen-gated at compose time (a 13+ child's item is generic, no
 * name — rule #1, deterministic age gate), so no child load and no child_name_level
 * dial is applied here — that dial governs the OUTBOUND text, not this receipt.
 */

/** Where a composed item came from, derived from its kind — the "where this came
 * from" the Sunday text names, so the receipt and the text stay in step. A Record
 * so a new kind can't be added without giving it a label (compile-time exhaustive). */
const PROVENANCE: Record<WeekPlanItem['kind'], string> = {
  routine: 'from your routines',
  village: 'you saved this in Village',
  birthday: 'a birthday',
  appointment: 'an appointment',
  suggestion: 'an idea',
};

export function provenanceLabel(kind: WeekPlanItem['kind']): string {
  return PROVENANCE[kind];
}

/** An item that still asks something of the parent — a checkup to book, the one
 * suggestion to decide. The "needs your OK" ledger, drawn from `needs`. */
export function itemNeedsOk(item: WeekPlanItem): boolean {
  return item.needs !== 'none';
}

export interface WeekPlanDayGroup {
  /** The items' shared `startsAt` day key, or null for day-coarse / undated items. */
  dayKey: string | null;
  items: WeekPlanItem[];
}

/**
 * Groups a plan's items into day columns: dated items bucketed by their `startsAt`
 * key ascending (chronological — the key is `YYYY-MM-DD`, so a string sort is a
 * date sort), then a trailing null group for day-coarse items (a month-granular
 * checkup, a recurring routine) shown under "sometime this week". Input order is
 * preserved within a day. Pure — unit-tested without a render.
 */
export function groupItemsByDay(items: readonly WeekPlanItem[]): WeekPlanDayGroup[] {
  const byDay = new Map<string, WeekPlanItem[]>();
  const undated: WeekPlanItem[] = [];
  for (const item of items) {
    if (item.startsAt === null) {
      undated.push(item);
      continue;
    }
    const bucket = byDay.get(item.startsAt) ?? [];
    bucket.push(item);
    byDay.set(item.startsAt, bucket);
  }
  const groups: WeekPlanDayGroup[] = [...byDay.keys()]
    .sort()
    .map((dayKey) => ({ dayKey, items: byDay.get(dayKey) as WeekPlanItem[] }));
  if (undated.length > 0) groups.push({ dayKey: null, items: undated });
  return groups;
}

/** `monday · Jul 6` — the day-group heading. The startsAt key is a bare family-local
 * calendar day, so both the weekday and the date are read in UTC (never the viewer's
 * zone), matching how the rest of the plan surface renders calendar dates. */
function dayHeading(dayKey: string): string {
  return `${WEEKDAYS[weekdayIndexIn(dayKey, 'UTC')]} · ${formatCalendarDate(dayKey)}`;
}

/** A calendar-day label for a single item, or null when it's day-coarse. */
function itemDay(item: WeekPlanItem): string | null {
  return item.startsAt ? formatCalendarDate(item.startsAt.slice(0, 10)) : null;
}

/** One plan item: its title over a quiet provenance (+ optional day / location)
 * caption. The title carries `data-hale-pii` for the redaction pass. */
function ItemRow({ item, withDay }: { item: WeekPlanItem; withDay?: boolean }) {
  const day = withDay ? itemDay(item) : null;
  const caption = [provenanceLabel(item.kind), day].filter(Boolean).join(' · ');
  return (
    <div>
      <p className="text-base text-spruce leading-relaxed" data-hale-pii>
        {item.title}
      </p>
      <p className="meta mt-0.5 text-slate-green">{caption}</p>
      {item.location ? (
        <p className="meta mt-0.5 text-slate-green" data-hale-pii>
          {item.location}
        </p>
      ) : null}
    </div>
  );
}

export function WeekPlanCard({ plan }: { plan: WeekPlan }) {
  const pending = plan.items.filter(itemNeedsOk);
  const handled = plan.items.filter((i) => !itemNeedsOk(i));
  return (
    <div className="space-y-6">
      {plan.summary ? (
        <p className="font-display text-[1.375rem] leading-snug text-spruce" data-hale-pii>
          {plan.summary}
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div>
          <span className="eyebrow text-spruce">needs your OK</span>
          <div className="panel-apricot-tint px-5 py-4 mt-3 space-y-4">
            {pending.map((item, idx) => (
              <ItemRow key={`p-${item.kind}-${idx}`} item={item} withDay />
            ))}
          </div>
        </div>
      ) : null}

      {handled.length > 0 ? (
        <div>
          <span className="eyebrow text-slate-green">on your calendar</span>
          <div className="mt-3 space-y-5">
            {groupItemsByDay(handled).map((group) => (
              <div key={group.dayKey ?? 'sometime'}>
                <p className="meta text-faded-sage">
                  {group.dayKey ? dayHeading(group.dayKey) : 'sometime this week'}
                </p>
                <div className="mt-2 space-y-3">
                  {group.items.map((item, idx) => (
                    <ItemRow key={`${group.dayKey ?? 'x'}-${item.kind}-${idx}`} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
