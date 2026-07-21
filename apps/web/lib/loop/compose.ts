import type { WeekPlanItem } from '@hale/db';
import { deriveStage } from '@hale/types';
import type { WeekWindow } from '~/lib/plan/spine';

/**
 * The deterministic weekly-plan composer (VIL-217 — "the Sunday brain"): folds the
 * already-gathered family signals for ONE upcoming week into the typed `WeekPlanItem`
 * list B2 renders and B3 acts on. Pure + I/O-free (the gather layer does the DB reads
 * and hands the shaped inputs in), so every rule — kinds, teen redaction, ordering,
 * the cap — is unit-tested without a request or the LLM.
 *
 * The single teen gate lives HERE and nowhere else in the composer: a 13+ child's
 * items are made GENERIC in the artifact itself (not just at render), via the
 * deterministic age gate `deriveStage(dob) === 'teenager'` — never the classifier
 * flag (rule #1, policy 3). The one exemption is parent-authored plans, which this
 * composer does not surface as items (see gather).
 */

/** Health items due within this many whole weeks count as an appointment for the
 * upcoming week. Health `dueInWeeks` is month-coarse, so this is "this week / next
 * week", never a specific day. */
export const APPOINTMENT_HORIZON_WEEKS = 1;

/** At most this many items surface; the overflow collapses routines to a summary
 * line ("…and your usual routines") so the plan stays scannable (ticket cap). */
export const MAX_ITEMS = 8;

const TEEN_APPOINTMENT_TITLE = 'a private appointment for your teen';
const TEEN_BIRTHDAY_TITLE = 'a birthday in the family';
const ROUTINES_OVERFLOW_TITLE = 'and your usual routines';

export interface ComposeChild {
  id: string;
  name: string | null;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
}

export interface ComposeHealth {
  childId: string;
  what: string;
  kind: 'immunization' | 'well_child_visit';
  /** Whole weeks until due (month-coarse). */
  dueInWeeks: number;
}

/** A routine already condensed to a pattern by the gather layer (never a line-item).
 * `day` is a weekday label or null ("anytime") — not PII, survives teen redaction. */
export interface ComposeRoutinePattern {
  label: string;
  day: string | null;
}

export interface ComposeVillage {
  id: string;
  title: string;
  /** Family-local `YYYY-MM-DD`, in-window for dated saves; null for the suggestion. */
  eventDate: string | null;
  location: string | null;
}

export interface ComposeFamilyEvent {
  id: string;
  /** The child it concerns, or null for a family-wide occasion. */
  childId: string | null;
  title: string;
  /** Family-local `YYYY-MM-DD` (the gather layer resolves the instant to a key). */
  startKey: string;
  endKey: string | null;
  location: string | null;
}

export interface ComposeInputs {
  window: WeekWindow;
  children: ComposeChild[];
  health: ComposeHealth[];
  routines: ComposeRoutinePattern[];
  villageDated: ComposeVillage[];
  suggestion: ComposeVillage | null;
  familyEvents: ComposeFamilyEvent[];
}

/** Rank order for the cap + display: concrete commitments first, the optional
 * suggestion last. appointments > birthdays > village(dated) > routines > suggestion. */
const KIND_RANK: Record<WeekPlanItem['kind'], number> = {
  appointment: 0,
  birthday: 1,
  village: 2,
  routine: 3,
  suggestion: 4,
};

function isTeen(child: ComposeChild, now: Date): boolean {
  return deriveStage(child.dateOfBirth, now) === 'teenager';
}

/** This-year birthday key for a `YYYY-MM-DD` DOB, evaluated against the week's year.
 * Feb-29 DOBs fall on Feb-28 in a common year (JS Date rolls Feb-29 to Mar-1, so we
 * clamp explicitly). Returns a `YYYY-MM-DD` key. */
function birthdayKeyInYear(dob: string, year: number): string {
  const [, mm, dd] = dob.split('-');
  if (mm === '02' && dd === '29') return `${year}-02-28`;
  return `${year}-${mm}-${dd}`;
}

function appointmentItems(inputs: ComposeInputs, now: Date): WeekPlanItem[] {
  const childById = new Map(inputs.children.map((c) => [c.id, c]));
  const items: WeekPlanItem[] = [];
  for (const h of inputs.health) {
    if (h.dueInWeeks > APPOINTMENT_HORIZON_WEEKS) continue;
    const child = childById.get(h.childId);
    if (!child) continue;
    const teen = isTeen(child, now);
    items.push({
      kind: 'appointment',
      // Teen: generic, no name, no specifics in the artifact itself (rule #1). A
      // younger child names the item; privacy_sensitive still genericizes it for SMS.
      title: teen ? TEEN_APPOINTMENT_TITLE : `${child.name ?? 'Your child'} — ${h.what}`,
      childIds: [child.id],
      startsAt: null, // month-coarse: never fabricate a weekday
      endsAt: null,
      location: null,
      sourceRef: null,
      needs: 'calendar_add',
      privacySensitive: true,
    });
  }
  return items;
}

function birthdayItems(inputs: ComposeInputs, now: Date): WeekPlanItem[] {
  const { startKey, endKey } = inputs.window;
  const year = Number(startKey.slice(0, 4));
  const items: WeekPlanItem[] = [];
  for (const child of inputs.children) {
    // A week can span a year boundary (Dec→Jan); check the birthday in BOTH the
    // start-key year and the end-key year, then keep the one that lands in-window.
    for (const y of new Set([year, Number(endKey.slice(0, 4))])) {
      const key = birthdayKeyInYear(child.dateOfBirth, y);
      if (key < startKey || key > endKey) continue;
      const teen = isTeen(child, now);
      items.push({
        kind: 'birthday',
        title: teen ? TEEN_BIRTHDAY_TITLE : `${child.name ?? 'Your child'}'s birthday`,
        childIds: [child.id],
        startsAt: key,
        endsAt: null,
        location: null,
        sourceRef: { table: 'children', id: child.id },
        needs: 'none',
        privacySensitive: false,
      });
    }
  }
  return items;
}

/** Family-added occasions (family_events) fold into the `birthday` kind — the ticket
 * groups them there ("children's DOBs + family-added events"), the canonical case
 * being a birthday party. Teen-scoped events genericize like a teen birthday. */
function familyEventItems(inputs: ComposeInputs, now: Date): WeekPlanItem[] {
  const teenIds = new Set(inputs.children.filter((c) => isTeen(c, now)).map((c) => c.id));
  const { startKey, endKey } = inputs.window;
  const items: WeekPlanItem[] = [];
  for (const e of inputs.familyEvents) {
    if (e.startKey < startKey || e.startKey > endKey) continue;
    const teen = e.childId !== null && teenIds.has(e.childId);
    items.push({
      kind: 'birthday',
      title: teen ? TEEN_BIRTHDAY_TITLE : e.title,
      childIds: e.childId ? [e.childId] : [],
      startsAt: e.startKey,
      endsAt: teen ? null : e.endKey,
      location: teen ? null : e.location,
      sourceRef: { table: 'family_events', id: e.id },
      needs: 'none',
      privacySensitive: false,
    });
  }
  return items;
}

function villageItems(inputs: ComposeInputs): WeekPlanItem[] {
  const { startKey, endKey } = inputs.window;
  const items: WeekPlanItem[] = [];
  for (const v of inputs.villageDated) {
    if (v.eventDate === null || v.eventDate < startKey || v.eventDate > endKey) continue;
    items.push({
      kind: 'village',
      title: v.title,
      childIds: [],
      startsAt: v.eventDate,
      endsAt: null,
      location: v.location,
      sourceRef: { table: 'village_candidates', id: v.id },
      needs: 'calendar_add',
      privacySensitive: false,
    });
  }
  return items;
}

function routineItems(inputs: ComposeInputs): WeekPlanItem[] {
  return inputs.routines.map((r) => ({
    kind: 'routine' as const,
    title: r.label,
    childIds: [],
    startsAt: null, // a recurring pattern has no single day; `day` label lives in the title
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none' as const,
    privacySensitive: false,
  }));
}

function suggestionItem(inputs: ComposeInputs): WeekPlanItem | null {
  const s = inputs.suggestion;
  if (!s) return null;
  return {
    kind: 'suggestion',
    title: s.title,
    childIds: [],
    startsAt: s.eventDate,
    endsAt: null,
    location: s.location,
    sourceRef: { table: 'village_candidates', id: s.id },
    // The one suggestion needs the parent's yes — never auto-scheduled (ticket).
    needs: 'decision',
    privacySensitive: false,
  };
}

/**
 * Compose the week's item list. Gathers each source into `WeekPlanItem`s, orders by
 * kind rank (then by any date), and caps to MAX_ITEMS — collapsing the routine
 * overflow into a single "…and your usual routines" line rather than dropping
 * concrete commitments. An empty week returns `[]` (a real artifact — the ticket).
 */
export function composeWeekPlan(inputs: ComposeInputs, now: Date = new Date()): WeekPlanItem[] {
  const appointments = appointmentItems(inputs, now);
  const birthdays = [...birthdayItems(inputs, now), ...familyEventItems(inputs, now)];
  const village = villageItems(inputs);
  const routines = routineItems(inputs);
  const suggestion = suggestionItem(inputs);

  const ordered = sortItems([...appointments, ...birthdays, ...village, ...routines]);
  const nonRoutine = ordered.filter((i) => i.kind !== 'routine');
  const routineOrdered = ordered.filter((i) => i.kind === 'routine');

  // Reserve one slot for the suggestion (if any); everything else competes for the
  // rest. Concrete commitments (appointments/birthdays/village) are kept whole; the
  // routines collapse to a summary line when they'd push the plan past the cap.
  const suggestionSlots = suggestion ? 1 : 0;
  const budget = MAX_ITEMS - suggestionSlots;

  const kept: WeekPlanItem[] = [];
  for (const item of nonRoutine) {
    if (kept.length < budget) kept.push(item);
  }
  const routineBudget = budget - kept.length;
  if (routineOrdered.length > 0) {
    if (routineOrdered.length <= routineBudget) {
      kept.push(...routineOrdered);
    } else if (routineBudget > 0) {
      // Some routine room but not all fit → one collapsed summary line.
      kept.push(routinesSummary());
    }
  }
  if (suggestion) kept.push(suggestion);
  return kept;
}

function routinesSummary(): WeekPlanItem {
  return {
    kind: 'routine',
    title: ROUTINES_OVERFLOW_TITLE,
    childIds: [],
    startsAt: null,
    endsAt: null,
    location: null,
    sourceRef: null,
    needs: 'none',
    privacySensitive: false,
  };
}

/** Stable order: by kind rank, then by start key (dated before undated), then title. */
function sortItems(items: WeekPlanItem[]): WeekPlanItem[] {
  return [...items].sort((a, b) => {
    if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
    const ak = a.startsAt ?? '￿';
    const bk = b.startsAt ?? '￿';
    if (ak !== bk) return ak < bk ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}
