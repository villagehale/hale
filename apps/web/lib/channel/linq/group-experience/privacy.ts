/**
 * Whether a group line repeats a string from the chat's deny list (the private terms of
 * every household in it, built by `denyListForChat`). These are the facts Hale already
 * holds, not a word list of intents.
 */
export function groupLineLeaksPrivate(line: string, deny: readonly string[]): boolean {
  const folded = line.toLowerCase();
  for (const token of deny) {
    const needle = token.trim().toLowerCase();
    if (needle.length >= 3 && folded.includes(needle)) return true;
  }
  return false;
}
