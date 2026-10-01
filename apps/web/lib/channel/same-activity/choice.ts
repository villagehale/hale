import type { SameActivityKind } from './match';

/**
 * An explicit opt-in is the whole message, after trim and a trailing period.
 *
 * "meet please", "join the group", and STOP are not a choice. STOP is a
 * carrier keyword answered upstream; claiming it here would mix a legal
 * opt-out with this activity.
 */
export function readSameActivityChoice(body: string): SameActivityKind | 'no' | null {
  const word = body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/u, '');
  if (word === 'meet') return 'meet';
  if (word === 'join') return 'join_group';
  if (word === 'no') return 'no';
  return null;
}
