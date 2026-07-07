import type { schema } from '@hale/db';
import type { OnboardingIntent, PlanTier } from '@hale/types';
import { type FamilyStage, deriveStage, parseIntents } from '@hale/types';

/**
 * The Family page's editable basics: each child's name, current derived stage,
 * and date_of_birth (needed so an edit form prefills), plus the family's
 * structured (coarse) location and plan tier. Stage is derived live from
 * date_of_birth (never stored); `now` is injectable so the mapping is
 * deterministic in tests.
 */

export type ChildRow = typeof schema.children.$inferSelect;

const STAGE_LABEL: Record<FamilyStage, string> = {
  newborn: 'newborn',
  toddler: 'toddler',
  child: 'child',
  teenager: 'teenager',
};

export interface FamilyChildBasics {
  id: string;
  name: string;
  dateOfBirth: string;
  stageLabel: string;
}

export interface FamilyLocationView {
  country: string | null;
  province: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface FamilyBasicsView {
  location: FamilyLocationView;
  planTier: PlanTier;
  intents: OnboardingIntent[];
  /** Permanent first-100 ordinal; null = not a founding family. */
  foundingNumber: number | null;
  children: FamilyChildBasics[];
}

export interface FamilyRowBasics extends FamilyLocationView {
  planTier: PlanTier;
  intents: string[] | null;
  foundingNumber: number | null;
}

export function toFamilyBasics(
  family: FamilyRowBasics | null,
  children: ReadonlyArray<Pick<ChildRow, 'id' | 'name' | 'dateOfBirth'>>,
  now: Date = new Date(),
): FamilyBasicsView {
  return {
    location: {
      country: family?.country ?? null,
      province: family?.province ?? null,
      city: family?.city ?? null,
      postalCode: family?.postalCode ?? null,
    },
    planTier: family?.planTier ?? 'free',
    intents: parseIntents(family?.intents ?? []),
    foundingNumber: family?.foundingNumber ?? null,
    children: children.map((child) => ({
      id: child.id,
      name: child.name,
      dateOfBirth: child.dateOfBirth,
      stageLabel: STAGE_LABEL[deriveStage(child.dateOfBirth, now)],
    })),
  };
}
