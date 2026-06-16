import {
  type FamilyStage,
  deriveStage,
  isBeyondProductAge,
} from '@hale/types';

/**
 * Onboarding's pure core. The wizard collects, per child, a name and a
 * date of birth; everything downstream (which stage Hale tailors to, the
 * family header labels) is a live function of that birthdate via deriveStage.
 * No stage is ever stored — date_of_birth is the only source of truth.
 *
 * Kept free of I/O so the validation, stage derivation, and insert-payload
 * shaping are unit-testable without a db or a request. The server action does
 * the persistence and passes raw form values in.
 */

/** A child as typed into the wizard, before validation. */
export interface ChildInput {
  name: string;
  /** A date-only `YYYY-MM-DD` string from the native date input. */
  dateOfBirth: string;
}

/** A validated child: trimmed name, a real birthdate, and its derived stage. */
export interface ValidatedChild {
  name: string;
  dateOfBirth: string;
  stage: FamilyStage;
}

export type ChildError = 'name_required' | 'dob_required' | 'dob_invalid' | 'dob_future' | 'dob_too_old';

export type ValidateChildResult =
  | { ok: true; child: ValidatedChild }
  | { ok: false; error: ChildError };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate + normalize one child input against the product's age window:
 * a birthdate must be a real date-only string, not in the future, and within
 * the 18-year ceiling (isBeyondProductAge). On success the derived stage is
 * attached. `now` is injectable so the boundary checks are deterministic.
 */
export function validateChild(input: ChildInput, now: Date = new Date()): ValidateChildResult {
  const name = input.name.trim();
  if (name.length === 0) {
    return { ok: false, error: 'name_required' };
  }

  const dob = input.dateOfBirth.trim();
  if (dob.length === 0) {
    return { ok: false, error: 'dob_required' };
  }
  if (!DATE_ONLY.test(dob)) {
    return { ok: false, error: 'dob_invalid' };
  }

  const parsed = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dob) {
    return { ok: false, error: 'dob_invalid' };
  }

  if (new Date(`${dob}T00:00:00`) > new Date(`${toDateOnly(now)}T00:00:00`)) {
    return { ok: false, error: 'dob_future' };
  }
  if (isBeyondProductAge(dob, now)) {
    return { ok: false, error: 'dob_too_old' };
  }

  return { ok: true, child: { name, dateOfBirth: dob, stage: deriveStage(dob, now) } };
}

function toDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The distinct stages a family spans, in childhood order, derived from the
 * children's birthdates. This is the UNION the experience tailors to — a
 * family with a newborn and a teenager spans both. Deduped and ordered so the
 * preview reads "newborn + teenager", never "teenager + newborn" or dupes.
 */
const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

export function unionStages(children: ReadonlyArray<{ stage: FamilyStage }>): FamilyStage[] {
  const present = new Set(children.map((c) => c.stage));
  return STAGE_ORDER.filter((stage) => present.has(stage));
}

/**
 * The insert payload for the children table, scoped to a family. Only the
 * source-of-truth columns are written — name and date_of_birth. No stage
 * column exists; nothing derived is persisted.
 */
export interface ChildInsert {
  familyId: string;
  name: string;
  dateOfBirth: string;
}

export function buildChildInserts(
  familyId: string,
  children: ReadonlyArray<Pick<ValidatedChild, 'name' | 'dateOfBirth'>>,
): ChildInsert[] {
  return children.map((child) => ({
    familyId,
    name: child.name,
    dateOfBirth: child.dateOfBirth,
  }));
}
