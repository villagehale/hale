/**
 * THE VOICE TELLS — the habits the register bans, as regexes, corpus-wide.
 *
 * Extracted from run-coach-channel-eval.mjs when the register's own negative rules
 * (docs/voice.md rules 1 and 3) joined the list, for the reason the menu gate was
 * extracted before it: a corpus gate that fires on NOTHING looks exactly like a corpus
 * gate that is broken. The red pass for these four classes came back empty — no fixture
 * in the committed cache says any of it — so the only evidence that they are live is a
 * test that feeds them the sentences they exist to catch.
 *
 * The four classes, and why each is here rather than in the judge's rubric:
 *
 *  1 · SELF-DESCRIBING ASSISTANT. The register is "a friend who happens to know the
 *      schedule". "I'm Hale, the assistant that keeps your week straight" is the exact
 *      sentence the skill quotes as the failure. The carve-out is mechanical and not a
 *      judgement call: "I'm an AI assistant, not a person" is the HONEST answer on a
 *      doubt turn and stays legal, so the word is only a tell when AI is not in front
 *      of it. The carve-out sits on BOTH patterns of the class, and that is one rule
 *      stated once rather than a style choice: it was on the first-person pattern only,
 *      so "I am the AI assistant behind this number, not a person" — the answer the
 *      skill REQUIRES on a doubt turn ("you are an AI and you say so plainly") — was a
 *      corpus-wide hard fail through the possessive pattern. Whatever the determiner,
 *      AI in front of the word makes the sentence the honest answer. The price is that
 *      "your AI assistant" is legal here too; it is a sentence that says it is an AI,
 *      and the judge still grades the register.
 *  2 · THE ACCOUNT / SETTINGS POINTERS. App-pointing without the word "app". The
 *      2026-08-15 incident was a parent told twice that referral links live in their
 *      account settings, of a product with neither. `\bthe app\b` is deliberately NOT
 *      repeated here — APP_POINTING in the eval already carries it, corpus-wide and
 *      form-agnostic, and a second copy is a rule that can drift away from the first.
 *  3 · THE OPENER FRAMES. A phone shows about 153 characters and every trim cuts from
 *      the end, so a first clause spent on "here's an update" is spent on nothing.
 *  4 · THE let-me-know FAMILY — already here since the gate was written, and named as
 *      one of the four so the count means something.
 *
 * Every entry grades the POST-PROCESSED reply, like every other gate in that file.
 */

/** @type {ReadonlyArray<readonly [RegExp, string]>} */
export const VOICE_TELLS = [
  [/\b(?:reach out|feel free|don'?t hesitate)\b/i, 'signs off like an assistant'],
  [/\blet me know\b/i, 'ends on a generic "let me know"'],
  [/\bhappy to help\b/i, 'chirpy filler'],
  [
    /\b(?:i can only|more than i can|in one message|my limit)\b/i,
    "explains its own limits instead of the parent's week",
  ],
  [
    /\b(?:i'?m|i am)\b[^.?!]{0,40}(?<!\bAI )\bassistant\b/i,
    'introduces itself as an assistant (the register is a friend, not a service)',
  ],
  [/\b(?:your|the)\s+(?:\w+\s+){0,2}(?<!\bAI )assistant\b/i, 'positions Hale as an assistant'],
  [/\byour account\b/i, 'sends the parent to an account they never opened'],
  [/\b(?:in|your|check(?:ing)?) settings\b/i, 'points at a settings screen from inside the thread'],
  [
    /(?:here'?s an update|just letting you know|just a quick note|quick note:|just wanted to let you know)/i,
    'opens on a frame instead of the fact',
  ],
];

/** Every tell this reply carries, by label. Empty means the reply is clean. */
export function voiceTells(reply) {
  return VOICE_TELLS.filter(([pattern]) => pattern.test(reply)).map(([, label]) => label);
}
