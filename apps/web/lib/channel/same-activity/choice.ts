import type { SameActivityKind } from './match';

/**
 * What the model already decided about a same-activity reply.
 *
 * There is no word list. "meet", "join", and "no" are not tokens. Carrier
 * STOP is answered upstream and never arrives here as a choice.
 */
export type SameActivityChoice = SameActivityKind | 'no';
