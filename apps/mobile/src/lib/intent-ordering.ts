/**
 * Deterministic intent-driven ordering (Consumer 2). A family's stated onboarding
 * intents float the rows tagged with a matching intent to the top, preserving the
 * original relative order otherwise — a stable partition, never an LLM ranking or a
 * "recommended for you" score. No intents (or a tag no row carries) leaves the list
 * exactly as given, so an untagged surface is unaffected. Pure — no I/O.
 */
export function orderByIntents<T>(
  rows: readonly T[],
  intentOf: (row: T) => string | undefined,
  intents: readonly string[],
): T[] {
  const selected = new Set(intents);
  const matched: T[] = [];
  const rest: T[] = [];
  for (const row of rows) {
    const tag = intentOf(row);
    if (tag !== undefined && selected.has(tag)) {
      matched.push(row);
    } else {
      rest.push(row);
    }
  }
  return [...matched, ...rest];
}
