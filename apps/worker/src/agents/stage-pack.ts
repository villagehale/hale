import { FAMILY_STAGES, type FamilyStage } from '@hale/types';
import { loadPrompt } from '../prompts/loader.js';

/**
 * Stage-aware content packs (backlog B17). A family stage gets a slice of
 * context — its event landscape, action emphases, and coach tone — that rides
 * the existing prompt machinery. The pack `.md` files live in
 * `prompts/packs/<name>.md` and are versioned + lockfile-checked like every
 * other prompt (CLAUDE.md hard rule #2).
 *
 * A multi-child family spans multiple stages at once (a newborn and a
 * teenager can share a household), so a family gets every distinct pack its
 * stages call for, concatenated in childhood order.
 */

/**
 * The packs that actually exist on disk. This is deliberately NOT `FamilyStage`:
 * the authored pack set is Langfuse-owned and drift-checked, so a new stage
 * cannot mint itself a pack from disk (hard rule #2).
 */
const PACK_NAMES = ['newborn', 'toddler', 'child', 'teenager'] as const;

type PackName = (typeof PACK_NAMES)[number];

/**
 * Which authored pack each stage reads.
 *
 * VIL-266 added the `preschool` stage, but `packs/preschool` has to be authored
 * in Langfuse and re-synced before it can be loaded here. Until it lands, a
 * preschooler reads exactly the pack they read when 48–59 months still derived
 * `child` — so this change moves no prompt content. Repointing `preschool` at
 * its own pack is the one-line follow-up once step 2 of VIL-266 ships.
 */
const PACK_BY_STAGE: Readonly<Record<FamilyStage, PackName>> = {
  newborn: 'newborn',
  toddler: 'toddler',
  preschool: 'child',
  child: 'child',
  teenager: 'teenager',
};

export type StagePackText = Readonly<Record<PackName, string>>;

const PACK_HEADER = '## Stage-aware context';

let loadedPacks: StagePackText | undefined;

/** Load the pack files from disk once. Reuses the prompt loader's cache. */
export async function loadStagePacks(): Promise<StagePackText> {
  if (loadedPacks) return loadedPacks;
  const entries = await Promise.all(
    PACK_NAMES.map(async (name) => [name, await loadPrompt(`packs/${name}`)] as const),
  );
  loadedPacks = Object.fromEntries(entries) as StagePackText;
  return loadedPacks;
}

/**
 * Pure: render the context packs for the stages present in a family, deduped
 * and ordered by childhood progression. Dedup is by PACK, not by stage — two
 * stages sharing a pack contribute it once. Returns an empty string for an empty
 * stage list so callers can append unconditionally. `packs` is injected for
 * testability; it defaults to the disk-loaded packs (call `loadStagePacks`
 * first in async contexts so the default is populated).
 */
export function stagePackFor(stages: FamilyStage[], packs?: StagePackText): string {
  const source = packs ?? loadedPacks;
  if (!source) {
    throw new Error('stagePackFor: packs not loaded — call loadStagePacks() first');
  }
  const present = FAMILY_STAGES.filter((stage) => stages.includes(stage));
  const names = [...new Set(present.map((stage) => PACK_BY_STAGE[stage]))];
  if (names.length === 0) return '';
  const body = names.map((name) => source[name]).join('\n\n---\n\n');
  return `${PACK_HEADER}\n\n${body}`;
}
