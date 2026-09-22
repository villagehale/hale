/**
 * Closed synonym lexicon for lexical memory search.
 *
 * Instinct finds "takeout" because the dining record lists it as an alias, and
 * misses "pazta" because nothing fuzzy-matches. Hale does the same with a fixed
 * list compiled into the repo — a parent's message cannot add a group, a token,
 * or an instruction. Child names are not in this list; a name matches only when
 * the query spells it.
 */

export const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'my',
  'our',
  'your',
  'me',
  'i',
  'to',
  'of',
  'for',
  'and',
  'or',
  'in',
  'on',
  'at',
  'is',
  'it',
  'we',
  'do',
  'does',
]);

/**
 * Each token belongs to at most one group. Groups are relationship and provider
 * synonyms a parent actually says ("daycare" / "my gf"), not a general thesaurus.
 */
export const LEXICON_GROUPS: readonly (readonly string[])[] = [
  ['daycare', 'childcare', 'nursery', 'preschool', 'provider'],
  ['mom', 'mother', 'mama', 'mum'],
  ['dad', 'father', 'papa'],
  ['partner', 'spouse', 'coparent', 'wife', 'husband', 'girlfriend', 'boyfriend', 'gf', 'bf'],
  ['grandma', 'grandmother', 'nana'],
  ['grandpa', 'grandfather'],
  ['doctor', 'pediatrician', 'clinic', 'physician'],
  ['school', 'classroom', 'teacher'],
  ['food', 'dining', 'pasta', 'lunch', 'dinner', 'restaurant', 'takeout', 'delivery'],
  ['bedtime', 'sleep', 'nap'],
  ['allergy', 'allergies', 'allergen'],
];

const GROUP_BY_TOKEN = new Map<string, readonly string[]>();
for (const group of LEXICON_GROUPS) {
  for (const token of group) {
    if (GROUP_BY_TOKEN.has(token)) {
      throw new Error(`lexicon token is in two groups: ${token}`);
    }
    GROUP_BY_TOKEN.set(token, group);
  }
}

/** Receipt namespaces the control plane reads back. Never forgotten, never briefed. */
export const RECEIPT_KEY_PREFIXES = ['health_checkpoint:', 'registration_outcome:'] as const;

/** Temporary beliefs a digest may retire. Writers opt in by key; messages cannot. */
export const EPHEMERAL_KEY_PREFIX = 'ephemeral.';

export function isReceiptKey(factKey: string): boolean {
  return RECEIPT_KEY_PREFIXES.some((prefix) => factKey.startsWith(prefix));
}

export function isEphemeralKey(factKey: string): boolean {
  return factKey.startsWith(EPHEMERAL_KEY_PREFIX);
}

/** Lowercase, strip everything outside [a-z0-9]. `child-care` and `child care` agree. */
export function normalizeToken(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Query or key tokens, stopwords removed, order preserved, duplicates kept out. */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!part || STOPWORDS.has(part) || seen.has(part)) continue;
    seen.add(part);
    tokens.push(part);
  }
  return tokens;
}

/** Query tokens plus every synonym of a token that sits in a group. */
export function expandTokens(tokens: readonly string[]): Set<string> {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    const group = GROUP_BY_TOKEN.get(token);
    if (!group) continue;
    for (const synonym of group) expanded.add(synonym);
  }
  return expanded;
}

export interface FactAlias {
  aliasNorm: string;
  source: 'key' | 'lexicon';
}

/**
 * Aliases for one fact key. Key tokens are stored as `key`; synonyms of those
 * tokens are stored as `lexicon`. The fact VALUE is never aliased — that is
 * parent prose, and prose does not get to choose a searchable namespace.
 */
export function aliasesForFactKey(factKey: string): FactAlias[] {
  const keyTokens = tokenize(factKey);
  const keySet = new Set(keyTokens);
  const aliases: FactAlias[] = [];
  for (const token of expandTokens(keyTokens)) {
    aliases.push({ aliasNorm: token, source: keySet.has(token) ? 'key' : 'lexicon' });
  }
  aliases.sort((a, b) => a.aliasNorm.localeCompare(b.aliasNorm));
  return aliases;
}

export function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export type MatchChannel = 'key' | 'alias' | 'value';

export interface ScoredFact {
  factKey: string;
  factValue: unknown;
  confidence: number;
  validFrom: Date;
  validUntil: Date | null;
  /** True when an alias-index row for this fact matched the expanded query. */
  aliasHit: boolean;
}

export interface FactScore {
  score: number;
  matchedBy: MatchChannel;
}

/**
 * Deterministic rank. Exact key tokens outrank alias hits, which outrank a
 * value mention. Closed facts sort after live ones. Recency is NOT in the
 * score — callers break ties on `validFrom` so two equally specific facts
 * surface the newer one without a recent aside beating an exact key.
 *
 * A typo scores 0. "pazta" does not contain "pasta", and we do not edit-distance.
 */
export function scoreFact(expanded: ReadonlySet<string>, fact: ScoredFact): FactScore | null {
  if (expanded.size === 0) return null;
  const keyTokens = new Set(tokenize(fact.factKey));
  const valueTokens = new Set(tokenize(valueText(fact.factValue).slice(0, 500)));
  let key = 0;
  let value = 0;
  for (const token of expanded) {
    if (keyTokens.has(token)) key += 100;
    else if (valueTokens.has(token)) value += 10;
  }
  const alias = fact.aliasHit ? 50 : 0;
  if (key + alias + value === 0) return null;
  const matchedBy: MatchChannel = key > 0 ? 'key' : alias > 0 ? 'alias' : 'value';
  let score = key + alias + value + Math.round(fact.confidence * 10);
  if (fact.validUntil !== null) score -= 1000;
  return { score, matchedBy };
}

/** Two spellings of one key, for the digest's contradiction count. */
export function normalizeFactKey(factKey: string): string {
  return factKey.toLowerCase().replace(/[^a-z0-9]/g, '');
}
