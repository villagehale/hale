import type { WeekPlanItem, schema } from '@hale/db';
import { deriveStage } from '@hale/types';

/**
 * VIL-241 · M6 — the ROLE dimension of the outbound chokepoint.
 *
 * A role is not a feature flag and not a permission bundle: it is a REDACTION LEVEL.
 * Everyone attached to a family sits on the same messaging surface, and what changes
 * between a parent and a grandparent is only how much of the family's week survives
 * the trip to their phone. That is the whole idea, and it is why this file is a
 * deterministic table rather than a set of `if (role === …)` checks scattered across
 * the senders: a scope you cannot read off one page is a scope nobody can audit.
 *
 * WHERE THIS SITS. The dispatch (dispatch.ts) is the single point every send passes
 * through; this module is the per-recipient filter that runs BEFORE a message is
 * composed for someone. It is the role dimension of the F14 outbound gate — when that
 * module lands, it composes with this one rather than replacing it: the gate answers
 * "may this family be texted at all", this answers "how much of it may THIS person
 * see". (F14's `apps/web/lib/channel/outbound-gate.ts` is not on main as of this
 * change; the caregiver senders that follow must route through both.)
 *
 * TWO GATES, ONE DIRECTION. The teen age gate composes ON TOP of the role scope and
 * is applied first, deterministically, from the child's DATE OF BIRTH via
 * `deriveStage` — never from a classifier flag (rule #1). An item concerning a 13+
 * child is `teen_content`, which no caregiver role allows, so a teen's week never
 * reaches a third party at all: not genericized, not summarized — absent.
 *
 * FAIL CLOSED. `classifyWeekItem` treats a child it cannot age as a teen. An item
 * referencing a child the caller did not load is an item we cannot prove is safe, and
 * the only safe reading of "cannot prove" is "do not send".
 */

export type FamilyRole = (typeof schema.familyRoleEnum.enumValues)[number];

/**
 * The classes of household content a message can carry. This taxonomy is the matrix's
 * column headings — the senders classify their own content into it (the week-plan
 * senders via `classifyWeekItem` below; the radar / registration and settings senders
 * classify at their own boundary), and the matrix decides who may receive each.
 */
export const CONTENT_CLASSES = [
  /** The week's schedule: what is happening, when. Routines, dated activities,
   * birthdays and family occasions — the plain calendar of the household. */
  'schedule',
  /** Who is collecting whom, and when. The single most useful thing a caregiver has. */
  'pickup_duty',
  /** The time + address of a specific item the recipient is attached to. */
  'event_logistics',
  /** Anything health-ish: appointments, immunizations, symptoms, anything flagged
   * privacy-sensitive. Never leaves the parents. */
  'health',
  /** Anything attributable to a 13+ child (rule #1's deterministic age gate). */
  'teen_content',
  /** The ranked village pick — a proposal that asks for a parent's decision. */
  'village_suggestion',
  /** Registration windows, deadlines, fees, anything financial. */
  'registration',
  /** Account, plan, autonomy level, members, privacy preferences. */
  'family_settings',
] as const;

export type ContentClass = (typeof CONTENT_CLASSES)[number];

/** The three SCOPED roles — people helping with the household who are not parents. */
export const CAREGIVER_ROLES = ['grandparent', 'nanny', 'babysitter'] as const satisfies
  readonly FamilyRole[];

export type CaregiverRole = (typeof CAREGIVER_ROLES)[number];

export function isCaregiverRole(role: FamilyRole): role is CaregiverRole {
  return (CAREGIVER_ROLES as readonly FamilyRole[]).includes(role);
}

/** A parent sees their own household. Teen content reaches them under rule #1's own
 * redaction (category/summary, raw only under a logged time-limited grant) — that is
 * a separate, finer gate applied at compose time; the ROLE does not withhold it. */
const PARENT_SCOPE: readonly ContentClass[] = CONTENT_CLASSES;

/** Exactly what the ticket grants a caregiver, and nothing that could grow into more:
 * where to be, when, and for what. */
const CAREGIVER_SCOPE: readonly ContentClass[] = ['schedule', 'pickup_duty', 'event_logistics'];

/**
 * Who may receive what. Exhaustive over `FamilyRole` BY TYPE — adding a role to the
 * enum without deciding its scope is a compile error, which is the point: a role with
 * an undecided scope is a leak waiting for someone to notice it.
 */
export const ROLE_SCOPE: Record<FamilyRole, ReadonlySet<ContentClass>> = {
  primary_parent: new Set(PARENT_SCOPE),
  co_parent: new Set(PARENT_SCOPE),
  grandparent: new Set(CAREGIVER_SCOPE),
  nanny: new Set(CAREGIVER_SCOPE),
  babysitter: new Set(CAREGIVER_SCOPE),
  // The two original vague buckets. Nothing grants them and nobody can state what
  // they mean, so they carry NO scope — an empty set is the honest answer, and it
  // fails closed if a legacy row ever surfaces one.
  extended: new Set<ContentClass>(),
  service: new Set<ContentClass>(),
};

export function roleAllows(role: FamilyRole, contentClass: ContentClass): boolean {
  return ROLE_SCOPE[role].has(contentClass);
}

export interface ScopeChild {
  id: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string;
}

/** The children the deterministic age gate makes teens as of `now` (rule #1). */
export function teenChildIds(children: readonly ScopeChild[], now: Date): Set<string> {
  return new Set(
    children.filter((c) => deriveStage(c.dateOfBirth, now) === 'teenager').map((c) => c.id),
  );
}

/**
 * The content class a composed week item belongs to. Order matters and is the policy:
 * teen involvement decides first (it outranks everything, including a cheerful-looking
 * item), then health, then the one suggestion, and only what is left is schedule.
 */
export function classifyWeekItem(item: WeekPlanItem, teenIds: ReadonlySet<string>): ContentClass {
  if (item.childIds.some((id) => teenIds.has(id))) return 'teen_content';
  if (item.kind === 'appointment' || item.privacySensitive) return 'health';
  if (item.kind === 'suggestion') return 'village_suggestion';
  return 'schedule';
}

export interface ScopeWeekInput {
  role: FamilyRole;
  items: readonly WeekPlanItem[];
  /** Every child the items may reference. A referenced child MISSING from this list
   * is treated as a teen — see the fail-closed note in the module header. */
  children: readonly ScopeChild[];
  now: Date;
}

/**
 * The week a given role may actually be sent. Items only — child NAMING stays with the
 * renderer, which already resolves the family's `child_name_level`; duplicating that
 * here would give a caregiver a second, drifting answer to "what may I call this kid".
 */
export function scopeWeekItemsForRole(input: ScopeWeekInput): WeekPlanItem[] {
  const teenIds = teenChildIds(input.children, input.now);
  const known = new Set(input.children.map((c) => c.id));
  return input.items.filter((item) => {
    if (item.childIds.some((id) => !known.has(id))) return roleAllows(input.role, 'teen_content');
    return roleAllows(input.role, classifyWeekItem(item, teenIds));
  });
}
