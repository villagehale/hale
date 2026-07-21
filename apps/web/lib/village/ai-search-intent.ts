import { z } from 'zod';
import { STAGE_BOUNDARIES_MONTHS } from '@hale/types';
import { SEASONS, type Season } from './visibility';

/**
 * The typed understanding of a natural-language village search. The LLM parses a
 * parent's prompt ("a good Montessori start in fall") into THIS shape — it NEVER
 * generates listings. Results come exclusively from real data (village_candidates +
 * the season/discovery machinery); the intent is only how we UNDERSTAND the ask, so
 * every field is a query hint over real fields, never a fabricated result.
 *
 * Teen privacy (rule #1): `childAgeMonths` is derived from the family's REAL,
 * NON-TEEN children — the parser is only ever given non-teen ages, so a 13+ child's
 * age can never enter the intent (and the parse normalizer clamps it as defence in
 * depth). When the ask targets a child we won't name (a teen), the parser sets
 * `familyScoped` and leaves the age null, so the interpretation echo says "for your
 * family", never "for a 15-year-old".
 */

/** The real board filter categories a search can name (the 'all' chip is the
 * absence of a category, so it is not a value the model emits). Kept in lockstep
 * with BoardFilter minus 'all' — a fabricated category would surface a tab with no
 * backing data. */
export const SEARCH_CATEGORIES = ['activities', 'childcare', 'resources', 'playgrounds'] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

/** The teen boundary in completed months (STAGE_BOUNDARIES_MONTHS = [12,48,156]);
 * an age at/above it is a teenager and must never surface as a concrete age in the
 * echo (rule #1). */
const TEEN_MONTHS = STAGE_BOUNDARIES_MONTHS[2];

/** A hard ceiling on how many match terms we keep from one prompt — a search is a
 * short phrase, not a paragraph; this bounds both the model's output and the
 * deterministic fallback so neither can balloon the query. */
const MAX_KEYWORDS = 8;

export interface VillageSearchIntent {
  /** Real board categories the ask maps to (may be empty — an open "find me
   * something" names none). */
  categories: SearchCategory[];
  /** Free match terms drawn from the ask (montessori, swim, "french immersion") —
   * substring-matched against a candidate's own real fields, never used to invent
   * a result. Lowercased, de-duped, bounded. */
  keywords: string[];
  /** The season the ask points at, or null. Drives the season-scoped search-run
   * pool + discovery (the #179 machinery), so a "fall" search reads fall picks even
   * in summer. */
  season: Season | null;
  /** The resolved age (completed months) of the NON-TEEN child the ask targets, or
   * null when no child / only a teen was referenced. Never a teen age (rule #1). */
  childAgeMonths: number | null;
  /** True when the ask targets the family (or a child we won't name — a teen), so
   * the echo reads "for your family" instead of a concrete age. */
  familyScoped: boolean;
}

/**
 * The model's raw JSON, validated leniently: an out-of-vocab category or season is
 * dropped (costs the FIELD, never the whole parse — the discovery eval's
 * attribute-level lesson), childAgeMonths is coerced to an integer, and unknown keys
 * are stripped. A structurally-broken answer fails the parse and the caller falls
 * back to the deterministic keyword intent (rule #8: degrade visibly, still search).
 */
const rawIntentSchema = z.object({
  categories: z
    .array(z.enum(SEARCH_CATEGORIES).catch(undefined as unknown as SearchCategory))
    .catch([])
    .default([]),
  keywords: z.array(z.string()).catch([]).default([]),
  season: z.enum(SEASONS).nullable().catch(null).default(null),
  childAgeMonths: z.number().finite().nonnegative().nullable().catch(null).default(null),
  familyScoped: z.boolean().catch(false).default(false),
});

/** Normalize a keyword list: trim, lowercase, drop empties, de-dupe, bound. Shared
 * by the model-parse and the deterministic fallback so both produce the same shape. */
function normalizeKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of raw) {
    const t = term.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}

/** The first balanced `{…}` object in a string, or null. The parser is instructed
 * to answer with a single JSON object; the model sometimes wraps it in prose, so we
 * take the first object literal (mirrors rank.ts pulling the first `[…]` array). */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the model's free-text answer into a validated intent, or null when it
 * carries no usable JSON object (the caller then falls back to the deterministic
 * keyword intent — rule #8). Categories/keywords are normalized and a would-be teen
 * age is nulled to `familyScoped` as a rule-#1 backstop (the parser is never given
 * teen ages, so this only ever fires on a malformed model answer).
 */
export function parseIntentAnswer(answer: string | null): VillageSearchIntent | null {
  if (!answer) return null;
  const json = firstJsonObject(answer);
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = rawIntentSchema.safeParse(value);
  if (!parsed.success) return null;
  const raw = parsed.data;
  const categories = [...new Set(raw.categories.filter((c): c is SearchCategory => c != null))];

  // Rule #1 backstop: a teen-range age must never reach the echo. The parser is only
  // ever given non-teen ages, so a >= TEEN_MONTHS value here means a malformed answer
  // — drop the concrete age and treat the ask as family-scoped instead of leaking it.
  const teenAge = raw.childAgeMonths !== null && raw.childAgeMonths >= TEEN_MONTHS;
  const childAgeMonths = teenAge ? null : raw.childAgeMonths === null ? null : Math.round(raw.childAgeMonths);

  return {
    categories,
    keywords: normalizeKeywords(raw.keywords),
    season: raw.season,
    childAgeMonths,
    familyScoped: raw.familyScoped || teenAge,
  };
}

/** English season words → the canonical Season, for the deterministic fallback. */
const SEASON_WORDS: Record<string, Season> = {
  spring: 'spring',
  summer: 'summer',
  fall: 'fall',
  autumn: 'fall',
  winter: 'winter',
};

/** Terms too generic to search on — dropped from the deterministic fallback so it
 * matches on the meaningful words, not filler. Small on purpose: the fallback is a
 * safety net, not a language model. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'for', 'my', 'our', 'me', 'we', 'i', 'to', 'of', 'in', 'on', 'at', 'and',
  'or', 'with', 'some', 'any', 'good', 'great', 'best', 'near', 'nearby', 'find', 'want', 'need',
  'looking', 'look', 'something', 'anything', 'kid', 'kids', 'child', 'children', 'this', 'that',
  'is', 'are', 'do', 'does', 'can', 'you', 'please', 'hale',
]);

/**
 * The deterministic fallback intent, used when the LLM parse fails (rule #8: never
 * a swallowed error — log it and STILL search). Pure keyword extraction: split the
 * prompt into words, drop stopwords, keep the season word if present. No category,
 * no age (it can't safely infer those) — so the search degrades to an honest keyword
 * match, never a fabricated interpretation.
 */
export function keywordFallbackIntent(prompt: string): VillageSearchIntent {
  const words = prompt.toLowerCase().match(/[a-zà-ÿ']+/gi) ?? [];
  let season: Season | null = null;
  const keywords: string[] = [];
  for (const word of words) {
    const w = word.toLowerCase();
    if (!season && SEASON_WORDS[w]) {
      season = SEASON_WORDS[w];
      continue;
    }
    if (!STOPWORDS.has(w) && w.length > 1) keywords.push(w);
  }
  return {
    categories: [],
    keywords: normalizeKeywords(keywords),
    season,
    childAgeMonths: null,
    familyScoped: false,
  };
}

/** True when an intent carries no usable query signal at all — an empty prompt or a
 * prompt of pure stopwords. The core treats it as "show the standing pool" and the
 * echo reads as a plain "near you". */
export function isEmptyIntent(intent: VillageSearchIntent): boolean {
  return (
    intent.categories.length === 0 &&
    intent.keywords.length === 0 &&
    intent.season === null &&
    intent.childAgeMonths === null &&
    !intent.familyScoped
  );
}

/** A human age label for the echo ("3-year-old", "8-month-old"). Never a teen age
 * (the caller only passes non-teen months). */
function humanAge(months: number): string {
  if (months < 12) return `${months}-month-old`;
  return `${Math.round(months / 12)}-year-old`;
}

/**
 * The honest interpretation echo the parent sees — "what Hale understood" — built
 * ONLY from the intent's real fields, in reading order: what, then where in the
 * calendar, then who. Teen-safe (rule #1): a family-scoped ask (or one with no
 * resolved age) reads "for your family", never a teen's age. An empty intent reads
 * "near you" (the search shows the standing pool).
 */
export function formatInterpretation(intent: VillageSearchIntent): string {
  const parts: string[] = [];
  for (const keyword of intent.keywords) parts.push(keyword);
  for (const category of intent.categories) parts.push(category);
  if (intent.season) parts.push(`starting ${intent.season}`);
  if (intent.childAgeMonths !== null) parts.push(`for a ${humanAge(intent.childAgeMonths)}`);
  else if (intent.familyScoped) parts.push('for your family');

  if (parts.length === 0) return 'near you';
  return parts.join(' · ');
}
