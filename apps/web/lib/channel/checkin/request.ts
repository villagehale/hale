import { containsPhrase, foldWords, opensWith } from './words';

/**
 * VIL-353 · IS THIS PARENT TELLING HALE ABOUT THEIR DAY, OR ASKING HALE FOR SOMETHING?
 *
 * The evening handler is the broadest claimer in the product: every other deterministic
 * handler recognises a SHAPE (a keyword, an address, a link) and this one claims a
 * sentence. While the question stands — 20:17 to 08:00 local, which is most of the hours
 * a parent actually texts — anything it claims is filed as a diary line and answered with
 * "Noted", and the coach never sees it. So "add swim to the calendar Saturday 10am" got a
 * thank-you note and no swim class.
 *
 * THE AMBIGUITY RESOLVES TOWARD THE COACH, ALWAYS. The evening note is the cheap half of
 * this exchange: losing one costs Hale a line in a store nothing reads yet, and the
 * standing question simply lapses. Losing a request costs the parent the thing they asked
 * for. So this screen is deliberately trigger-happy — every marker below refuses the
 * CLAIM, never the parent — and the handful of diary lines it mistakes for requests are
 * answered by the coach, which can say something true about them either way.
 *
 * IT IS A FLOOR AND NOT A CLASSIFIER, the same shape and the same limit as the privacy
 * deny-list next door (notes.ts): explicit markers, no model, no inference. Reading the
 * sentence with a model to place it better is VIL-354's problem; v1 makes no model call at
 * all, and a floor that is honest about being one beats a heuristic that pretends.
 */

/**
 * A word that, at the FRONT of a message, is a parent asking rather than telling.
 *
 * Position matters: "call" opening a message is an instruction and "call it a win" in the
 * middle of one is an evening. Only the first word is read.
 */
const ASKING_OPENERS: readonly string[] = [
  // Interrogatives that carry no question mark when typed in a hurry.
  'what',
  'whats',
  'when',
  'where',
  'who',
  'whos',
  'why',
  'how',
  'which',
  'whose',
  'can',
  'could',
  'would',
  'will',
  'should',
  'do',
  'does',
  'did',
  'is',
  'are',
  'any',
  'anyone',
  'anything',
  // Things a parent tells Hale to do.
  'add',
  'book',
  'cancel',
  'change',
  'check',
  'delete',
  'draft',
  'email',
  'find',
  'forward',
  'get',
  'help',
  'look',
  'make',
  'move',
  'put',
  'register',
  'remind',
  'remove',
  'reschedule',
  'schedule',
  'search',
  'send',
  'set',
  'share',
  'show',
  'sign',
  'tell',
  'text',
  'update',
  // The same two groups in French, where Hale answers in French.
  'quel',
  'quelle',
  'quand',
  'ou',
  'pourquoi',
  'comment',
  'est',
  'peux',
  'pouvez',
  'pourrais',
  'ajoute',
  'trouve',
  'rappelle',
  'envoie',
  'reserve',
  'annule',
  'inscris',
];

/** A request, wherever in the message it appears — most often after the answer itself
 * ("Good day. Can you book swim for Saturday"). */
const ASKING_PHRASES: readonly string[] = [
  'can you',
  'can u',
  'could you',
  'would you',
  'will you',
  'please',
  'pls',
  'remind me',
  'let me know',
  'sign us up',
  'sign me up',
  'text me',
  'send me',
  'look into',
  'i need you to',
  'peux tu',
  'pourrais tu',
  'rappelle moi',
  'envoie moi',
];

/**
 * Whether this message is addressed to Hale as a request rather than as an answer.
 *
 * The question mark is the first and plainest marker and is read off the RAW body, since
 * the fold strips punctuation before anything else runs.
 */
export function asksHaleForSomething(body: string): boolean {
  if (body.includes('?')) return true;
  const folded = foldWords(body);
  if (ASKING_OPENERS.some((word) => opensWith(folded, word))) return true;
  return ASKING_PHRASES.some((phrase) => containsPhrase(folded, phrase));
}
