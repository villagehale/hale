import type { FamilyStage } from '@hearth/types';
import { loadPrompt } from '../prompts/loader.js';

/**
 * Stage-aware content packs (backlog B17). Each of the four family stages
 * gets a slice of context — its event landscape, action emphases, and coach
 * tone — that rides the existing prompt machinery. The pack `.md` files live
 * in `prompts/packs/<stage>.md` and are versioned + lockfile-checked like
 * every other prompt (CLAUDE.md hard rule #2).
 *
 * A multi-child family spans multiple stages at once (a newborn and a
 * teenager can share a household), so a family gets every distinct stage's
 * pack, concatenated in childhood order.
 */

export type StagePackText = Readonly<Record<FamilyStage, string>>;

const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

const PACK_HEADER = '## Stage-aware context';

let loadedPacks: StagePackText | undefined;

/** Load the four pack files from disk once. Reuses the prompt loader's cache. */
export async function loadStagePacks(): Promise<StagePackText> {
  if (loadedPacks) return loadedPacks;
  const entries = await Promise.all(
    STAGE_ORDER.map(async (stage) => [stage, await loadPrompt(`packs/${stage}`)] as const),
  );
  loadedPacks = Object.fromEntries(entries) as StagePackText;
  return loadedPacks;
}

/**
 * Pure: render the context packs for the stages present in a family, deduped
 * and ordered by childhood progression. Returns an empty string for an empty
 * stage list so callers can append unconditionally. `packs` is injected for
 * testability; it defaults to the disk-loaded packs (call `loadStagePacks`
 * first in async contexts so the default is populated).
 */
export function stagePackFor(stages: FamilyStage[], packs?: StagePackText): string {
  const source = packs ?? loadedPacks;
  if (!source) {
    throw new Error('stagePackFor: packs not loaded — call loadStagePacks() first');
  }
  const present = STAGE_ORDER.filter((stage) => stages.includes(stage));
  if (present.length === 0) return '';
  const body = present.map((stage) => source[stage]).join('\n\n---\n\n');
  return `${PACK_HEADER}\n\n${body}`;
}
