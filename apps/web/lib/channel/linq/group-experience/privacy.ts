import type { FamilyPrivateSlice } from '../multi-family';

/**
 * Strings from a family's private slice that must not appear in a group line.
 * These are the facts Hale already holds, not a word list of intents.
 */
export function privateDenyTokens(slices: readonly FamilyPrivateSlice[]): string[] {
  const out: string[] = [];
  for (const slice of slices) {
    for (const value of [...slice.memory, ...slice.calendar, ...slice.email, ...slice.signups]) {
      const token = value.trim();
      if (token.length >= 3) out.push(token);
    }
  }
  return out;
}

export function groupLineLeaksPrivate(line: string, deny: readonly string[]): boolean {
  const folded = line.toLowerCase();
  for (const token of deny) {
    const needle = token.trim().toLowerCase();
    if (needle.length >= 3 && folded.includes(needle)) return true;
  }
  return false;
}
