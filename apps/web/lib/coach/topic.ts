/**
 * Coarse topic tagging for the conversation timeline. The family's ONE ongoing
 * conversation is filterable by topic; each turn gets a tag from the parent's
 * question. Keyword-based, no LLM — fast, deterministic, and good enough to bucket
 * a timeline. A miss is null (untagged), a valid state the filter treats as "other".
 */

export const TOPICS = [
  'sleep',
  'feeding',
  'health',
  'development',
  'behavior',
  'activities',
] as const;

export type Topic = (typeof TOPICS)[number];

const TOPIC_PATTERNS: ReadonlyArray<readonly [Topic, RegExp]> = [
  ['sleep', /\b(sleep|nap|naps|bedtime|night ?wak|waking|wakes? up|crib|drowsy)\b/i],
  ['feeding', /\b(feed|feeding|solids|breastfeed|bottle|formula|eat|eating|meal|weaning|allergen)\b/i],
  ['health', /\b(check[- ]?up|appointment|pediatric|doctor|fever|sick|vaccine|immuni|symptom|rash|teething)\b/i],
  ['development', /\b(milestone|crawl|walk|words|talk|speech|develop|grow(?:th|ing)?|potty)\b/i],
  ['behavior', /\b(tantrum|behavior|behaviour|discipline|screen ?time|whining|hitting|biting|mood|anxious)\b/i],
  ['activities', /\b(activit|class|classes|weekend|near (?:us|me|you)|outing|playgroup|swimming|music)\b/i],
];

/** Tag a question with its coarse topic, or null when nothing matches. */
export function tagTopic(question: string): Topic | null {
  const match = TOPIC_PATTERNS.find(([, pattern]) => pattern.test(question));
  return match ? match[0] : null;
}
