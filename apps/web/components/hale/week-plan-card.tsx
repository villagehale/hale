import type { WeekPlan, WeekPlanItem } from '@hale/db';
import type { FamilyStage } from '@hale/types';
import { ChildTag } from '~/components/hale/child-tag';
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

/**
 * VIL-244 · M9 — the multi-kid arrangement (D4/D20, founder principle). A week read by
 * a two- or three-kid family has to answer "who" before "what", so the receipts week
 * view groups day-first, then by kid in a consistent order (oldest first), then the
 * items that span more than one kid as a single visual grouping, then the family-wide
 * ones. Pure — the arrangement is unit-tested without a render.
 *
 * The who-label is derived from the child's live STAGE, which is `deriveStage` (rule
 * #1's deterministic age gate): a 13+ child is "your teen" in every position, so no
 * arrangement of the artifact can put a teen's name on the page. Item TITLES are
 * untouched — they were already teen-gated at compose time, and this surface shows the
 * account holder's own artifact as-is (see the module note above).
 */

/** The child facts the arrangement needs — exactly what /plan already loads. */
export interface WeekPlanKid {
  id: string;
  name: string;
  /** Family-local `YYYY-MM-DD`; the oldest-first ordering reads this. */
  dateOfBirth: string;
  /** The live-derived stage. `teenager` IS the rule #1 age gate. */
  stage: FamilyStage;
}

export interface WeekPlanKidGroup {
  /** React key — stable for a given day + child set. */
  key: string;
  /** The "who" for these lines, or null for family-wide / unattributed items. */
  who: string | null;
  items: WeekPlanItem[];
}

export interface WeekPlanDaySection {
  dayKey: string | null;
  groups: WeekPlanKidGroup[];
}

const TEEN_WHO = 'your teen';
const BOTH_WHO = 'Both';
const EVERYONE_WHO = 'Everyone';
const TWO_KIDS = 2;

/** The name a kid may be shown by: their own, unless the age gate says otherwise. */
function kidWho(kid: WeekPlanKid): string {
  return kid.stage === 'teenager' ? TEEN_WHO : kid.name;
}

/**
 * The label for the kids an item concerns. One kid → their (gated) name. Every kid in
 * the family → "Both" for two, "Everyone" for more. A subset of three-plus → the
 * actual gated names joined, never the fabricated "Everyone". No known kid → null.
 */
function groupWho(kids: WeekPlanKid[], familySize: number): string | null {
  if (kids.length === 0) return null;
  if (kids.length === 1) return kidWho(kids[0] as WeekPlanKid);
  if (kids.length === familySize) return familySize === TWO_KIDS ? BOTH_WHO : EVERYONE_WHO;
  return kids.map(kidWho).join(' & ');
}

/** Oldest first — an earlier date of birth sorts ahead. */
function oldestFirst(kids: readonly WeekPlanKid[]): WeekPlanKid[] {
  return [...kids].sort((a, b) => a.dateOfBirth.localeCompare(b.dateOfBirth));
}

/**
 * Buckets items by their CALENDAR day, ascending, with the day-coarse ones trailing.
 * Distinct from `groupItemsByDay`, which keys on the raw `startsAt` — two items on the
 * same date at different clock times are one day here, which is what "day-first" means
 * to a parent reading the week. (The pre-M9 card keeps its own keying untouched.)
 */
function bucketByCalendarDay(
  items: readonly WeekPlanItem[],
): Array<{ dayKey: string | null; items: WeekPlanItem[] }> {
  const byDay = new Map<string, WeekPlanItem[]>();
  const undated: WeekPlanItem[] = [];
  for (const item of items) {
    if (item.startsAt === null) {
      undated.push(item);
      continue;
    }
    const key = item.startsAt.slice(0, 10);
    const bucket = byDay.get(key) ?? [];
    bucket.push(item);
    byDay.set(key, bucket);
  }
  const days = [...byDay.keys()]
    .sort()
    .map((dayKey) => ({ dayKey, items: byDay.get(dayKey) as WeekPlanItem[] }));
  return undated.length > 0 ? [...days, { dayKey: null, items: undated }] : days;
}

/**
 * Groups a plan's items day-first, then by the kid(s) each concerns. Within a day the
 * per-kid groups come first (oldest kid first), then the multi-kid groups, then the
 * unattributed ones — the reading order a parent scans.
 */
export function groupWeekByKid(
  items: readonly WeekPlanItem[],
  kids: readonly WeekPlanKid[],
): WeekPlanDaySection[] {
  const ordered = oldestFirst(kids);
  const rank = new Map(ordered.map((kid, index) => [kid.id, index]));
  return bucketByCalendarDay(items).map(({ dayKey, items: dayItems }) => {
    const buckets = new Map<string, { sort: number; group: WeekPlanKidGroup }>();
    for (const item of dayItems) {
      const named = ordered.filter((kid) => item.childIds.includes(kid.id));
      const who = groupWho(named, ordered.length);
      // Sort key: per-kid groups by the oldest kid they name, multi-kid groups after
      // every single kid, unattributed last.
      const sort =
        named.length === 0
          ? ordered.length + 1
          : named.length === 1
            ? (rank.get((named[0] as WeekPlanKid).id) as number)
            : ordered.length;
      const key = named.length === 0 ? 'family' : named.map((kid) => kid.id).join('+');
      const existing = buckets.get(key);
      if (existing) existing.group.items.push(item);
      else buckets.set(key, { sort, group: { key, who, items: [item] } });
    }
    const groups = [...buckets.values()].sort((a, b) => a.sort - b.sort).map((b) => b.group);
    return { dayKey, groups };
  });
}

/** The items dated on the family's local `todayKey` — the compact Today strip's rows.
 * `startsAt` may carry a clock time, so only its calendar-day head is compared. */
export function todayItems(items: readonly WeekPlanItem[], todayKey: string): WeekPlanItem[] {
  return items.filter((item) => item.startsAt?.slice(0, 10) === todayKey);
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

/** The who-heading for a kid grouping, as the same static child pill every other
 * surface uses — an unattributed grouping reads "whole family". */
function KidHeading({ group }: { group: WeekPlanKidGroup }) {
  return <ChildTag childId={group.who === null ? null : group.key} label={group.who} />;
}

/** The day-first, kid-grouped rows for one region of the receipts week view. */
function KidGroupedDays({ items, kids }: { items: WeekPlanItem[]; kids: readonly WeekPlanKid[] }) {
  return (
    <div className="mt-3 space-y-5">
      {groupWeekByKid(items, kids).map((section) => (
        <div key={section.dayKey ?? 'sometime'}>
          <p className="meta text-faded-sage">
            {section.dayKey ? dayHeading(section.dayKey) : 'sometime this week'}
          </p>
          <div className="mt-2 space-y-4">
            {section.groups.map((group) => (
              <div key={group.key}>
                <KidHeading group={group} />
                <div className="mt-2 space-y-3">
                  {group.items.map((item, idx) => (
                    <ItemRow key={`${group.key}-${item.kind}-${idx}`} item={item} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * VIL-244 · M9 — the compact Today strip that replaces the demoted daily feed. It is
 * the SAME artifact rows the week below shows, narrowed to the family's local today,
 * so the two can never disagree. Nothing today says so in one line rather than
 * rendering an empty panel.
 */
export function WeekPlanToday({
  plan,
  kids,
  todayKey,
}: {
  plan: WeekPlan;
  kids: readonly WeekPlanKid[];
  todayKey: string;
}) {
  const items = todayItems(plan.items, todayKey);
  return (
    <div className="panel-oat px-5 py-4">
      <span className="eyebrow text-spruce">today</span>
      {items.length === 0 ? (
        <p className="meta mt-2 text-slate-green">nothing on today.</p>
      ) : (
        <div className="mt-3 space-y-4">
          {groupWeekByKid(items, kids).flatMap((section) =>
            section.groups.map((group) => (
              <div key={group.key}>
                <KidHeading group={group} />
                <div className="mt-2 space-y-3">
                  {group.items.map((item, idx) => (
                    <ItemRow key={`${group.key}-${item.kind}-${idx}`} item={item} />
                  ))}
                </div>
              </div>
            )),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * `kids` is the M9 receipts-room arrangement (VIL-244, flag-gated): passing the
 * family's children groups both regions day-first and then by kid. Omitting it renders
 * the pre-M9 card byte-for-byte.
 */
export function WeekPlanCard({ plan, kids }: { plan: WeekPlan; kids?: readonly WeekPlanKid[] }) {
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
          {kids ? (
            <div className="panel-apricot-tint px-5 py-4 mt-3">
              <KidGroupedDays items={pending} kids={kids} />
            </div>
          ) : (
            <div className="panel-apricot-tint px-5 py-4 mt-3 space-y-4">
              {pending.map((item, idx) => (
                <ItemRow key={`p-${item.kind}-${idx}`} item={item} withDay />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {handled.length > 0 ? (
        <div>
          <span className="eyebrow text-slate-green">on your calendar</span>
          {kids ? (
            <KidGroupedDays items={handled} kids={kids} />
          ) : (
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
          )}
        </div>
      ) : null}
    </div>
  );
}
