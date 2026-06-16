import type { schema } from '@hale/db';
import { type FamilyStage, deriveFamilyStages } from '@hale/types';

export type ChildRow = typeof schema.children.$inferSelect;

/**
 * Maps a family's children rows to the per-child header view the authed pages
 * show — each child's name and current derived stage, plus the union of stages
 * the family spans. Stage is derived live from date_of_birth (never stored);
 * `now` is injectable so the mapping is deterministic in tests.
 */

const STAGE_LABEL: Record<FamilyStage, string> = {
  newborn: 'newborn',
  toddler: 'toddler',
  child: 'child',
  teenager: 'teenager',
};

const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

export interface ChildHeaderView {
  id: string;
  name: string;
  stage: FamilyStage;
  stageLabel: string;
}

export interface FamilyHeaderView {
  children: ChildHeaderView[];
  /** Distinct stages the family spans, childhood-ordered — the union the
   * experience tailors to. */
  stages: FamilyStage[];
}

export function toFamilyHeader(
  children: ReadonlyArray<Pick<ChildRow, 'id' | 'name' | 'dateOfBirth'>>,
  now: Date = new Date(),
): FamilyHeaderView {
  const stages = deriveFamilyStages(children, now);
  const views: ChildHeaderView[] = children.map((child) => {
    const stage = stages.get(child.id) as FamilyStage;
    return { id: child.id, name: child.name, stage, stageLabel: STAGE_LABEL[stage] };
  });

  const present = new Set(views.map((v) => v.stage));
  return { children: views, stages: STAGE_ORDER.filter((stage) => present.has(stage)) };
}

/**
 * A short human phrase for the union of stages, for stage-aware page framing:
 * one stage → "the newborn months"; two+ → "newborn + teenager". Empty when
 * there are no children yet (the page renders its own empty state).
 */
export function stagePhrase(stages: ReadonlyArray<FamilyStage>): string {
  return stages.map((s) => STAGE_LABEL[s]).join(' + ');
}
