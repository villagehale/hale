import { stageFromAgeInMonths } from '@hale/types';
import type { FamilyChildRef } from './types';

/**
 * VIL-619 · whether any of these texts names one of the family's 13+ children.
 *
 * The deterministic half of the teen gate on an email: the model's attribution can miss a
 * child, the age gate cannot. Read at alert time (subject and snippet) and again when
 * `read_email` opens the body, because a child can turn 13 between the two.
 *
 * Only the given name is matched, as a whole word, after folding case, accents, width and
 * invisible characters. A surname is left out because a younger sibling shares it.
 */
export function namesTeenChild(
  texts: readonly string[],
  children: readonly Pick<FamilyChildRef, 'name' | 'ageInMonths'>[],
): boolean {
  const names = children
    .filter((child) => stageFromAgeInMonths(child.ageInMonths) === 'teenager')
    .map((child) => fold(child.name).trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0);
  if (names.length === 0) return false;
  const text = fold(texts.join('\n'));
  return names.some((name) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'u').test(text),
  );
}

function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
