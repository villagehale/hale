/**
 * Case-fold, trim, and drop surrounding punctuation/whitespace ("Yes." -> "yes").
 * A text normalizer for the health, party and registration replies' own whole-string
 * reads. It used to live in intake/keywords.ts, which #868 deleted.
 */
export function normalizeToken(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}
