/**
 * VIL-634 · the one teen-name matcher. Every gate that hides a teen's title or
 * text uses {@link namesAny}: NFKD fold, combining marks and format characters
 * dropped, every name part of two or more letters, whole word.
 *
 * It scans the string it is given. Callers that walk an object decide which
 * strings to pass; {@link namesAnyIn} in memory-context walks values (and, for
 * memory facts, keys) so a nested field cannot hide a name.
 *
 * Over-matching a common word only withholds more, which is the safe direction
 * for rule #1. A child whose stored name equals an enum value is one row in the
 * evasion table: the matcher does not skip enum-shaped strings.
 */

function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `text` names any of `names` as a whole word, ignoring case, accents
 * and format characters. Each part of a name counts on its own ("Ana Sofia" is
 * named by "Sofia").
 */
export function namesAny(text: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const haystack = fold(text);
  for (const name of names) {
    for (const part of fold(name).split(/[^\p{L}\p{N}]+/u)) {
      if (part.length < 2) continue;
      const word = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(part)}($|[^\\p{L}\\p{N}])`, 'u');
      if (word.test(haystack)) return true;
    }
  }
  return false;
}
