/**
 * VIL-220 · C1 — the shape of an approval the model already placed.
 *
 * There is no word list here. A parent answering a drafted action is giving consent
 * (rule #4), and the reply resolver names the action by id. Carrier STOP, HELP, and
 * START never reach this router: the opt-out reader handles them first.
 */

export type FastPathVerb = 'yes' | 'no' | 'undo';

export interface FastPathCommand {
  verb: FastPathVerb;
  /** Left for the spine. The resolver names the action by id, so production passes null. */
  index: number | null;
}

/**
 * The largest ordinal a numbered SMS list can name, and therefore the cap on the list
 * itself — copy.ts imports this rather than picking its own, so the grammar can never
 * refuse a number Hale actually printed. Three is the voice rules' own limit on list
 * items over SMS. A bigger ordinal is a typo or a different sentence, and answering it
 * by clamping would approve a different action than the parent meant.
 */
export const MAX_LISTED_APPROVALS = 3;
