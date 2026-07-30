/**
 * VIL-243 · M8 — the framing lint.
 *
 * Hale has never seen a child's health record and never will (health-data ingestion is
 * out of scope for this feature and every feature after it). That means there is
 * exactly one honest register for health-admin copy — an administrative window and a
 * task — and a large family of sentences that read helpfully but assert something Hale
 * cannot know. This module is the machine-checkable half of that line.
 *
 * The four failures it guards against:
 *
 *   - JUDGMENT of the child ("behind", "delayed", "on track"). Hale has no baseline to
 *     compare against, so any of these is a claim invented at render time.
 *   - DIAGNOSIS-ADJACENT vocabulary ("symptom", "condition", "abnormal"). Even negated
 *     — "nothing abnormal here" — this moves the message into clinical register, which
 *     is exactly where a non-clinical product must not be.
 *   - ALARM ("urgent", "suspension", "immediately"). The real consequence behind D11 is
 *     a school-attendance interruption, and it IS motivating; saying it out loud turns
 *     a five-minute errand into a threat. The copy names the window, not the penalty.
 *   - SECOND-PERSON PRESSURE ("you must", "make sure you"). The product rule is offer,
 *     never instruct — and this is the only part of "posture" a regex can hold.
 *
 * WHY THIS IS NOT A LIST OF STRINGS. A literal-phrase lint passes "conditions",
 * "diagnosing", "urgently" and "at-risk" while catching their singulars, which makes it
 * a gate that only stops the author who was already being careful. So each entry is
 * compiled into a pattern by one of three builders, chosen by what a suffix would do to
 * that particular word:
 *
 *   stem()   — any continuation counts. Used only where no innocent English word
 *              extends the stem ("diagnos" cannot become anything harmless).
 *   word()   — the word plus ordinary inflections, and nothing else. "late" must catch
 *              "lately" and "lateness" while leaving "lateral" and "later" alone, so it
 *              cannot be a stem.
 *   phrase() — tokens joined by a space OR a hyphen, each token inflectable. One entry
 *              covers "at risk", "at-risk"; "catch up", "catch-up", "catching up".
 *
 * The pressure family is written as four hand-rolled patterns instead, because it is
 * paraphrase rather than inflection: "you must", "you'll need to" and "you really
 * should" are the same instruction wearing different clothes, and no word list catches
 * all three.
 *
 * Matches are reported as the TEXT THAT MATCHED, not the rule that fired, so a failing
 * content review says "your copy contains 'diagnosing'" rather than naming a stem the
 * author never wrote.
 */

/** Ordinary English inflections. Deliberately short: every letter added here is a
 * letter that could pull an innocent word into a ban ('r' would make "later" match). */
const INFLECTION = '(?:s|es|ed|ing|ly|y|ness)?';

/** Any continuation counts. */
function stem(value: string): RegExp {
  return new RegExp(`\\b${value}\\w*\\b`, 'i');
}

/** The word and its ordinary inflections, nothing further. */
function word(value: string): RegExp {
  return new RegExp(`\\b${value}${INFLECTION}\\b`, 'i');
}

/** Tokens separated by a space or a hyphen, each inflectable. */
function phrase(value: string): RegExp {
  const tokens = value.split(/\s+/).map((token) => `${token}${INFLECTION}`);
  return new RegExp(`\\b${tokens.join('[\\s-]+')}\\b`, 'i');
}

/** The judgment vocabulary: every one of these is a claim about the CHILD. */
const JUDGMENT: RegExp[] = [
  stem('behind'),
  stem('delay'),
  stem('overdue'),
  stem('abnormal'),
  stem('milestone'),
  word('late'),
  word('miss'),
  word('normal'),
  word('slow'),
  word('ahead'),
  word('risk'),
  phrase('should already'),
  phrase('should have'),
  phrase('on track'),
  phrase('off track'),
  phrase('at risk'),
  phrase('catch up'),
];

/** Clinical register. Hale describes paperwork, not health. */
const CLINICAL: RegExp[] = [
  stem('diagnos'),
  stem('symptom'),
  stem('disorder'),
  stem('disease'),
  stem('illness'),
  stem('unhealthy'),
  stem('deficien'),
  stem('condition'),
  word('immune'),
];

/** Alarm. The window is the message; the consequence is not. */
const ALARM: RegExp[] = [
  stem('urgent'),
  stem('emergency'),
  stem('immediat'),
  stem('panic'),
  stem('suspend'),
  stem('suspension'),
  stem('penalt'),
  phrase('right away'),
  word('asap'),
];

/**
 * Second-person pressure. Patterns, not phrases: the instruction survives any amount of
 * hedging between the pronoun and the verb ("you will need to", "you really should"),
 * so the gap is what is matched rather than each spelling of it.
 */
const PRESSURE: RegExp[] = [
  /\byou\b[\w\s']{0,20}\b(?:must|need to|have to|should)\b/i,
  /\bmake sure\b/i,
  /\bbe sure\b/i,
  /\b(?:don't|don’t|dont|do not)\s+forget\b/i,
];

/** Every rule, in report order. Exported so a review can see the size of the gate. */
export const HEALTH_BANNED_PHRASES: readonly RegExp[] = [
  ...JUDGMENT,
  ...CLINICAL,
  ...ALARM,
  ...PRESSURE,
];

/**
 * The banned TEXT this string contains, lowercased, in rule order. Empty is the only
 * shippable result for anything a parent can read.
 */
export function findBannedPhrases(text: string): string[] {
  const found: string[] = [];
  for (const pattern of HEALTH_BANNED_PHRASES) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].toLowerCase());
  }
  return found;
}
