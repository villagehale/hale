import type { WeekPlan, WeekPlanItem } from '@hale/db';
import { Card } from '~/components/ui/card';
import { formatCalendarDate } from '~/lib/format/datetime';
import { WEEKDAYS, weekdayIndexIn } from '~/lib/plan/spine';

/**
 * The in-app receipt for B1's composed week (VIL-218 · B2 parity). Renders the
 * SAME persisted `week_plans` artifact the Sunday text sends — never a re-derived
 * live view — so the two can't disagree. Each item shows its provenance (derived
 * from `kind`, the artifact carries no provenance string) and a "needs your OK"
 * chip when it still asks something of the parent.
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

function WeekPlanItemCard({ item }: { item: WeekPlanItem }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill">{provenanceLabel(item.kind)}</span>
        {itemNeedsOk(item) ? <span className="pill pill-apricot">needs your OK</span> : null}
      </div>
      <p className="text-lg text-spruce leading-relaxed mt-3" data-hale-pii>
        {item.title}
      </p>
      {item.location ? (
        <p className="meta mt-1 text-slate-green" data-hale-pii>
          {item.location}
        </p>
      ) : null}
    </Card>
  );
}

export function WeekPlanCard({ plan }: { plan: WeekPlan }) {
  const groups = groupItemsByDay(plan.items);
  return (
    <div className="space-y-6">
      {plan.summary ? (
        <p className="text-lg text-spruce leading-relaxed" data-hale-pii>
          {plan.summary}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.dayKey ?? 'sometime'}>
          <span className="eyebrow text-slate-green">
            {group.dayKey ? dayHeading(group.dayKey) : 'sometime this week'}
          </span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            {group.items.map((item, idx) => (
              <WeekPlanItemCard key={`${group.dayKey ?? 'x'}-${item.kind}-${idx}`} item={item} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
