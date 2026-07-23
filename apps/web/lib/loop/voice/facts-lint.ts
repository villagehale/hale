/**
 * VIL-229 · the voice-slot fact guard.
 *
 * The house voice seam lets the MODEL write the user-facing sentences (greeting,
 * narrative, item framing, sign-off), but FACTS — times, dates, links — are
 * INJECTED by the deterministic shell, never generated. This lint is the guard:
 * it scans a model-written voice string for the two fact shapes a warm sentence
 * must never invent — a clock time (`\d{1,2}:\d{2}`) or a URL — and returns any
 * that do NOT appear verbatim in one of the injected fact slots the model was
 * handed. A non-empty result means the model fabricated a specific; composeVoice
 * treats that as a failure and degrades to the deterministic copy (rule #8).
 *
 * The lint is deliberately narrow: it catches the two highest-risk fabrications
 * (a wrong appointment time, an invented link) with zero false positives on prose
 * that only reuses the facts it was given. It is NOT a general hallucination
 * detector — child names are already teen-gated/name-leveled before the model ever
 * sees them (rule #1), and titles ride as slots too.
 */

// A clock time: 1-2 digit hour, ':', 2 digit minute. Word-bounded so a bare date
// key ("2026-07-24", no colon) never matches.
const TIME_RE = /\b\d{1,2}:\d{2}\b/g;
// An http(s) URL. \S+ greedily takes the whole token; trailing sentence
// punctuation is trimmed below so "…/plan." matches the "…/plan" slot.
const URL_RE = /https?:\/\/\S+/g;

/** Trailing punctuation a URL match may swallow from surrounding prose. */
const URL_TRAILING = /[).,;:!?'"]+$/;

/**
 * The TIME- and URL-shaped tokens present in `text` that do NOT appear in any of
 * `allowedSlots` (the injected facts the model was handed). Empty when the text
 * invents no time or link. De-duped.
 */
export function findInventedFacts(text: string, allowedSlots: string[]): string[] {
  const times = text.match(TIME_RE) ?? [];
  const urls = (text.match(URL_RE) ?? []).map((u) => u.replace(URL_TRAILING, ''));
  const candidates = [...new Set([...times, ...urls])];
  if (candidates.length === 0) return [];
  return candidates.filter((fact) => !allowedSlots.some((slot) => slot.includes(fact)));
}

/**
 * Throw when `text` invents a time or link not present in `allowedSlots`. The
 * message names the offenders (never PII — a time or URL fragment) so a failing
 * voice run is diagnosable in logs.
 */
export function assertNoInventedFacts(text: string, allowedSlots: string[]): void {
  const invented = findInventedFacts(text, allowedSlots);
  if (invented.length > 0) {
    throw new Error(`voice text invented facts not in slots: ${invented.join(', ')}`);
  }
}
