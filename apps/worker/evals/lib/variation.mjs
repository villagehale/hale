// The shared VARIATION gate for the composed-voice suites.
//
// WHY THIS EXISTS. Every composed surface in this repo replaced a stored string with a
// model call. The failure that buys nothing is CONVERGENCE: the model writes the same
// sentence for every family, or lifts the skill's own illustrative example into copy a
// parent reads, and the suite still passes green because each individual message is
// perfectly good on its own. That is a constant with an API bill.
//
// The 2026-08-13 tone audit found this shape on five surfaces at once — welcome-voice's
// closingNote verbatim in 6/6 draws, intake's 8/8 identical "Got it - " opener,
// general-answer's live-data deflect copied character-for-character off the skill's one
// positive example, calendar-email-ask rewording the skill's quoted sample, turn-apology
// shipping three byte-identical bodies past a distinct-strings counter that a single
// comma defeats. run-followup-voice-eval.mjs had grown the first two of these checks by
// hand (#429); this module is that pattern extracted so a composed surface inherits it
// instead of re-deriving it, and so the comma bug cannot be re-introduced one suite at a
// time.
//
// THREE CHECKS, one call:
//
//   (a) NEAR-DUPLICATE OUTPUTS. Any two fixtures whose bodies are identical once case and
//       punctuation are removed, or whose character-trigram similarity clears the
//       suite's threshold. Punctuation-insensitivity is the whole point: "…and nothing
//       changed." and "…, and nothing changed." are the same message.
//
//   (b) PARROTED SKILL SAMPLES. Any SENTENCE of an output that CONTAINS one of the
//       skill's own quoted examples. A skill that shows one good line and no others is a
//       skill asking to be copied, and the copy reaches a parent as Hale's own words.
//
//   (c) DISTINCT OPENERS AND CLOSERS. How a corpus of messages begins and ends is the
//       part that collapses first, long before whole bodies do — and a template driven
//       off one end simply moves to the other when only one end is measured. Fixing
//       intake's 8/8 "Got it - " opener produced 6/8 "- got it." endings on the very
//       next live draw, which is how this check came to have two halves.
//
// TWO METRICS, because the two questions are not the same question.
//
//   "Have these two messages converged?" is symmetric — trigram DICE, defaulting to 0.75.
//   Three quarters of the character texture shared between two independently-composed
//   short messages is a template, not a coincidence.
//
//   "Did the model copy the skill's line?" is asymmetric — trigram CONTAINMENT (shared
//   over the SHORTER string's total), defaulting to 0.90. Dice punishes a parrot for
//   padding: the calendar ask that wraps the skill's whole sample sentence in extra
//   clauses scores 0.69 Dice and 1.00 containment, and it is plainly a parrot.
//
// BOTH CALIBRATED against run-followup-voice-eval's corpus — the suite the 2026-08-13
// audit named as the model for the doctrine, and therefore the one a threshold must not
// punish. Its real cached asks peak at 0.57 Dice pairwise and 0.48 containment against
// its skill's samples, so a genuinely varied corpus clears both with room. Suites whose
// subject matter forces overlap (turn-apology says two fixed things in one sentence,
// every time) pass their own, and say why where they set it.

import { readFile } from 'node:fs/promises';

/** Three quarters of the character texture shared. See the header. */
export const DEFAULT_MAX_SIMILARITY = 0.75;

/** The skill's sentence is almost entirely inside the output. See the header. */
export const DEFAULT_MAX_CONTAINMENT = 0.9;

/**
 * A skill example shorter than this is a PHRASE, not a sentence — "no need to write
 * back", "even a word is fine", "not medical advice, but". Those are the vocabulary a
 * voice skill exists to teach, and a parrot gate that fires on them forbids the skill
 * from working. Seven is where the followup corpus separates cleanly: every phrase it
 * teaches is five or six words, and every full sample sentence is seven or more.
 */
const MIN_SAMPLE_WORDS = 7;

/** Case, punctuation and spacing removed. Apostrophes are DELETED rather than spaced so
 * "don't" and "dont" are one string — a composer's punctuation habits are not variety. */
export function normalizeForCompare(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first `words` normalized words — the cheap stand-in for "how this message opens". */
export function openerOf(text, words = 3) {
  return normalizeForCompare(text).split(' ').slice(0, words).join(' ');
}

/** The last `words` normalized words — the same stand-in for how it ends. */
export function closerOf(text, words = 3) {
  return normalizeForCompare(text).split(' ').slice(-words).join(' ');
}

function countWords(normalized) {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

function trigrams(normalized) {
  const padded = `  ${normalized} `;
  const counts = new Map();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    const gram = padded.slice(i, i + 3);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function overlap(left, right) {
  const a = trigrams(normalizeForCompare(left));
  const b = trigrams(normalizeForCompare(right));
  let aTotal = 0;
  let bTotal = 0;
  for (const n of a.values()) aTotal += n;
  for (const n of b.values()) bTotal += n;
  let shared = 0;
  for (const [gram, n] of a) shared += Math.min(n, b.get(gram) ?? 0);
  return { shared, aTotal, bTotal };
}

/** Dice coefficient over character trigrams of the normalized strings, 0..1 — the
 * SYMMETRIC "are these the same message" measure. Two empty strings are identical; one
 * empty string resembles nothing. */
export function similarity(left, right) {
  const { shared, aTotal, bTotal } = overlap(left, right);
  if (aTotal === 0 || bTotal === 0) return aTotal === bTotal ? 1 : 0;
  return (2 * shared) / (aTotal + bTotal);
}

/** How much of the SHORTER string's trigrams the longer one carries, 0..1 — the
 * ASYMMETRIC "is that sentence inside this one" measure. A parrot that pads is still a
 * parrot, and Dice would forgive it for the padding. */
export function containment(left, right) {
  const { shared, aTotal, bTotal } = overlap(left, right);
  const smaller = Math.min(aTotal, bTotal);
  if (smaller === 0) return aTotal === bTotal ? 1 : 0;
  return shared / smaller;
}

function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The skill's own quoted example sentences, normalized — blockquote lines, inline code
 * spans, and double-quoted runs in the prose. Read off the file rather than restated in
 * a runner, so an example someone adds later is covered without anyone remembering to.
 *
 * Fenced code blocks are EXCLUDED: they hold the output JSON schema, whose placeholder
 * descriptions are instructions to the model rather than sample copy, and matching
 * against them would flag a field for resembling its own specification.
 */
export async function skillSampleSentences(skillPath) {
  const source = (await readFile(skillPath, 'utf8')).replace(/```[\s\S]*?```/g, '\n');
  const quoted = [];
  for (const line of source.split('\n')) {
    // TRIMMED first. A blockquote nested inside a list item is indented, and reading
    // `line.startsWith('> ')` off the raw line silently skipped every one of them —
    // which is how general-answer's live-data examples, all four of them indented under
    // a bullet, stayed invisible to the parrot check while the model copied one of them
    // into a reply word for word.
    const trimmed = line.trim();
    if (trimmed.startsWith('> ')) quoted.push(trimmed.slice(2));
  }
  for (const match of source.matchAll(/`([^`\n]+)`/g)) quoted.push(match[1]);
  for (const match of source.matchAll(/"([^"\n]+)"/g)) quoted.push(match[1]);

  const samples = new Set();
  for (const chunk of quoted) {
    for (const sentence of splitSentences(chunk)) {
      const normalized = normalizeForCompare(sentence);
      if (countWords(normalized) >= MIN_SAMPLE_WORDS) samples.add(normalized);
    }
  }
  return [...samples];
}

/**
 * Run the three checks over one corpus of composed bodies.
 *
 * @param items              `[{ id, text }]` — one entry per composed body. A suite whose
 *                           voice object has several fields calls this once PER FIELD:
 *                           a greeting and a sign-off are not each other's duplicates.
 * @param samples            normalized skill sentences from `skillSampleSentences`.
 * @param maxSimilarity      the pairwise Dice ceiling (see DEFAULT_MAX_SIMILARITY).
 * @param maxContainment     the skill-parrot ceiling (see DEFAULT_MAX_CONTAINMENT).
 * @param minDistinctOpeners the opener floor, or null to skip that check.
 * @param minDistinctClosers the closer floor, or null to skip it. Set BOTH or the
 *                           template moves to the unmeasured end.
 * @param edgeWords          how many words count as the opening / the ending.
 */
export function variationGate({
  items,
  samples = [],
  maxSimilarity = DEFAULT_MAX_SIMILARITY,
  maxContainment = DEFAULT_MAX_CONTAINMENT,
  minDistinctOpeners = null,
  minDistinctClosers = null,
  edgeWords = 3,
}) {
  const present = items.filter((item) => normalizeForCompare(item.text) !== '');
  const failuresById = {};
  const addFailure = (id, failure) => {
    if (!failuresById[id]) failuresById[id] = [];
    failuresById[id].push(failure);
  };

  let worstPair = null;
  for (let i = 0; i < present.length; i += 1) {
    for (let j = i + 1; j < present.length; j += 1) {
      const a = present[i];
      const b = present[j];
      const score = similarity(a.text, b.text);
      if (worstPair === null || score > worstPair.score) {
        worstPair = { a: a.id, b: b.id, score };
      }
      if (score < maxSimilarity) continue;
      const label = score >= 0.999 ? 'identical to' : `${score.toFixed(2)} similar to`;
      addFailure(a.id, `near_duplicate: ${label} ${b.id}`);
      addFailure(b.id, `near_duplicate: ${label} ${a.id}`);
    }
  }

  let worstSample = null;
  for (const item of present) {
    for (const sentence of splitSentences(item.text)) {
      const normalized = normalizeForCompare(sentence);
      if (countWords(normalized) < MIN_SAMPLE_WORDS) continue;
      for (const sample of samples) {
        const score = containment(normalized, sample);
        if (worstSample === null || score > worstSample.score) {
          worstSample = { id: item.id, sample, score };
        }
        if (score < maxContainment) continue;
        addFailure(item.id, `parrots_skill_sample (${score.toFixed(2)}): "${sample.slice(0, 60)}"`);
        break;
      }
    }
  }

  const openers = new Set(present.map((item) => openerOf(item.text, edgeWords)));
  const closers = new Set(present.map((item) => closerOf(item.text, edgeWords)));
  const edgesOk =
    (minDistinctOpeners === null || openers.size >= minDistinctOpeners) &&
    (minDistinctClosers === null || closers.size >= minDistinctClosers);

  return {
    failuresById,
    worstPair,
    worstSample,
    distinctOpeners: openers.size,
    distinctClosers: closers.size,
    minDistinctOpeners,
    minDistinctClosers,
    maxSimilarity,
    maxContainment,
    passed: Object.keys(failuresById).length === 0 && edgesOk,
  };
}

/** The metric lines every wired suite prints, so the reports stay comparable. The worst
 * observed scores are printed even when they pass — a corpus creeping toward the ceiling
 * is the thing a reader wants to see before it trips. */
export function variationLines(report, { pairGated = true } = {}) {
  const pair = report.worstPair
    ? `${report.worstPair.score.toFixed(2)} (${report.worstPair.a} vs ${report.worstPair.b})`
    : 'n/a (one body)';
  const sample = report.worstSample
    ? `${report.worstSample.score.toFixed(2)} (${report.worstSample.id})`
    : 'n/a (no skill samples)';
  const pairBar = pairGated
    ? `(< ${report.maxSimilarity} required - a shared template is a preset body)`
    : '(REPORTED, NOT GATED - see the runner)';
  const lines = [
    `most similar pair:       ${pair}  ${pairBar}`,
    `closest skill sample:    ${sample}  (< ${report.maxContainment} required - the skill's own line is not copy)`,
  ];
  if (report.minDistinctOpeners !== null) {
    lines.push(
      `distinct openers:        ${report.distinctOpeners}  (>= ${report.minDistinctOpeners} required)`,
    );
  }
  if (report.minDistinctClosers !== null) {
    lines.push(
      `distinct closers:        ${report.distinctClosers}  (>= ${report.minDistinctClosers} required)`,
    );
  }
  return lines;
}
