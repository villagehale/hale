import { VOICE_GOODBYE_BY_LANGUAGE } from './copy';

/**
 * Voice v2 — HALE HANGS UP.
 *
 * THE INVARIANT: the parent says goodbye once, and the call ends.
 *
 * Until now a call could only end three ways, and a parent choosing to leave was none of
 * them: the nine-minute cap, the platform's own ceiling, or the caller pressing the red
 * button. On the founder's first real v2 call (CA170c1fb0) that cost three exchanges at
 * the end — "And that's all for today.", "Yeah. It's ciao. Bye bye.", "You can you can
 * hang up now." — each answered with a line and a live line afterwards, until the parent
 * gave up and hung up on Hale. A product that cannot take a hint is not a quiet operator.
 *
 * DETERMINISTIC, NO MODEL, and for the same reason the approvals grammar is
 * (voice-answer.ts): a goodbye is the parent taking an action, and asking a model whether
 * they meant it costs a couple of seconds of the exact silence they were trying to end.
 * It is also the only way this can be a table a person can read and argue with.
 *
 * IT IS BUILT TO BE UNDER-EAGER, on the same two-tier shape as `replyLanguage`
 * (channel/language.ts), because the two errors are not the same size. Missing a goodbye
 * costs one turn of a call the parent can still end themselves. Hanging up on a question
 * costs the whole call and a redial. So a farewell WORD is never enough on its own:
 * either the utterance is an explicit dismissal, or it is a farewell with NOTHING ELSE IN
 * IT. "ok bye can you first tell me when gym is" keeps the line.
 */

/**
 * Settles it alone: the parent is not saying goodbye, they are telling Hale to go. There
 * is no reading of these in which the call continues, so they do not have to pass the
 * all-filler bar below.
 */
const DISMISSAL = /\bhang(?:\s|ing\s)?up\b|\braccroch/;

/**
 * A farewell, in a phrase. Matched against the FOLDED utterance (see {@link fold}), so
 * "that's all" and "thats all" are one entry and "c'est tout" is `cest tout`.
 *
 * `salut` is deliberately absent: in French it is both hello and goodbye, and the greeting
 * reading is the one that arrives at the start of a call.
 */
const FAREWELL =
  /\b(?:bye|byebye|goodbye|good bye|ciao|adios|adieu|au revoir|a bientot|a plus|bonne journee|bonne soiree|bonne nuit|good night|take care|see you|later|thats all|that is all|thats it|that is it|cest tout|im done|im all done|were done|we are done|im good for now|thats everything|thats me done)\b/;

/** French farewells — which language the goodbye is spoken back in. Read off the FAREWELL
 * that matched rather than off {@link replyLanguage}, because a one-word "ciao" carries no
 * sentence for a language detector to weigh. */
const FRENCH_FAREWELL = /\bau revoir|a bientot|cest tout|bonne journee|bonne soiree|bonne nuit|adieu|raccroch/;

/**
 * Words that may sit around a goodbye without making it something else. Everything a
 * person actually says while leaving a phone call — the acknowledgement, the thank-you,
 * the filler — and nothing that could be a question.
 */
const CLOSING_FILLER = new Set([
  'a',
  'ah',
  'all',
  'alright',
  'and',
  'anyway',
  'appreciate',
  'awesome',
  'bien',
  'bon',
  'bonne',
  'brilliant',
  'cest',
  'cheers',
  'cool',
  'da',
  'de',
  'done',
  'et',
  'everything',
  'fine',
  'for',
  'good',
  'great',
  'hale',
  'have',
  'im',
  'is',
  'it',
  'its',
  'je',
  'journee',
  'just',
  'k',
  'lot',
  'me',
  'merci',
  'much',
  'my',
  'need',
  'nice',
  'no',
  'noon',
  'not',
  'now',
  'nuit',
  'ok',
  'okay',
  'oui',
  'perfect',
  'please',
  'rien',
  'right',
  'sil',
  'so',
  'soiree',
  'sounds',
  'stop',
  'sure',
  'talk',
  'te',
  'thank',
  'thanks',
  'thanku',
  'thankyou',
  'thats',
  'that',
  'the',
  'then',
  'this',
  'today',
  'tonight',
  'too',
  'tout',
  'tu',
  'up',
  'very',
  'vous',
  'we',
  'well',
  'were',
  'yea',
  'yeah',
  'yep',
  'yes',
  'you',
  'your',
  'youre',
  'yup',
]);

/** Every word of the FAREWELL table, so a farewell token never has to be repeated in
 * {@link CLOSING_FILLER} to satisfy the all-filler bar. */
const FAREWELL_WORDS = new Set([
  'adieu',
  'adios',
  'au',
  'bientot',
  'bye',
  'byebye',
  'care',
  'ciao',
  'goodbye',
  'later',
  'night',
  'plus',
  'revoir',
  'see',
  'take',
]);

/**
 * The utterance as bare words, on the two conventions the rest of the channel already
 * uses (language.ts / affirmative.ts): accents folded onto their base letter so one
 * table entry covers however Twilio spelled it, and the apostrophe CLOSED UP so "that's"
 * and "c'est" become the single tokens `thats` and `cest` rather than useless fragments.
 */
function fold(utterance: string): string {
  return utterance
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * What Hale should say before the line goes down, or null when this call is not over.
 *
 * Returning the LINE rather than a boolean is deliberate: the caller cannot end a session
 * without also having something to say, and a `true` that leaves the copy to the call site
 * is how a silent hang-up gets written.
 */
export function spokenFarewell(utterance: string): string | null {
  const folded = fold(utterance);
  if (folded === '') return null;

  const french = FRENCH_FAREWELL.test(folded);
  if (DISMISSAL.test(folded)) {
    // "the daycare hung up on me this morning" is somebody else's hang-up, reported.
    // Only the parent's own instruction ends a call.
    if (/\b(?:they|she|he|it|daycare|clinic|school|someone|somebody)\b/.test(folded)) return null;
    return VOICE_GOODBYE_BY_LANGUAGE[french ? 'fr' : 'en'];
  }

  if (!FAREWELL.test(folded)) return null;
  // THE BAR: a farewell and nothing else. One content word — "bye can you first tell me
  // when gym is" — and this is a question with a courtesy on the front of it.
  const everyWordIsClosing = folded
    .split(' ')
    .every((word) => CLOSING_FILLER.has(word) || FAREWELL_WORDS.has(word));
  if (!everyWordIsClosing) return null;

  return VOICE_GOODBYE_BY_LANGUAGE[french ? 'fr' : 'en'];
}
