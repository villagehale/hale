/**
 * VIL-144 — relevance ranking for the coach's memory and thread retrieval.
 *
 * Pure and deterministic: no model call on a turn a parent is waiting on, no I/O,
 * and nothing it returns can be invented. It only ORDERS rows the family already
 * owns; teen redaction, group scoping, opt-out, quiet hours and dedupe all stay
 * where they were, in code, around it.
 *
 * Language-agnostic by construction (no stop-word or keyword list): words are
 * Unicode letter/number runs, scripts written without spaces (Han, kana, Hangul,
 * Thai) are split into character bigrams, and every term is weighted by inverse
 * document frequency over the candidate pool itself, so common words in ANY
 * language weigh little and a rare name ("Juniper", "游泳课") weighs a lot.
 */

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;
const TERM_RUN = /[\p{L}\p{N}\p{M}]+/gu;

/** Split text into comparable terms, lowercased. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(TERM_RUN)) {
    const run = match[0];
    if (UNSPACED_SCRIPT.test(run)) {
      const chars = [...run];
      if (chars.length === 1) out.push(run);
      for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`);
    } else if ([...run].length >= 2) {
      out.push(run);
    }
  }
  return out;
}

export interface RankQuery {
  /** The parent's current message — full weight. */
  primary: string;
  /** Recent thread context (e.g. the last few turns) — half weight. */
  secondary?: readonly string[];
}

const SECONDARY_WEIGHT = 0.5;

/**
 * Score every document against the query with IDF-weighted term overlap. Index i of
 * the result is document i's score; 0 means it shares no term with the query.
 */
export function relevanceScores(docs: readonly string[], query: RankQuery): number[] {
  const docTerms = docs.map((d) => new Set(terms(d)));
  const df = new Map<string, number>();
  for (const set of docTerms) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const idf = (t: string) => Math.log(1 + n / (df.get(t) ?? n));

  const weights = new Map<string, number>();
  for (const t of terms(query.primary)) weights.set(t, 1);
  for (const s of query.secondary ?? []) {
    for (const t of terms(s)) if (!weights.has(t)) weights.set(t, SECONDARY_WEIGHT);
  }

  return docTerms.map((set) => {
    let score = 0;
    for (const [t, w] of weights) if (set.has(t)) score += w * idf(t);
    return score;
  });
}

/**
 * Top-K by relevance. Ties (including the all-zero case of a query that matches
 * nothing) keep the INPUT order, so a caller passes rows pre-sorted by its fallback
 * ranking (confidence, recency) and gets exactly that ranking back when relevance
 * has nothing to say.
 */
export function rankTopK<T>(
  items: readonly T[],
  text: (item: T) => string,
  query: RankQuery,
  k: number,
): T[] {
  const scores = relevanceScores(items.map(text), query);
  return items
    .map((item, index) => ({ item, index, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, k)
    .map((r) => r.item);
}
