import { describe, expect, it } from 'vitest';
import { replyLanguage } from './language';

/**
 * The detector's whole job is stated as two properties, and the tests are split along
 * them: a French parent must be HEARD, and an English parent must never be answered in a
 * language they did not write. The second is the expensive mistake, so it gets the
 * adversarial half of this file.
 */
describe('replyLanguage — a parent who wrote French', () => {
  it.each([
    ['bonjour on its own, which is how a stranger opens', 'Bonjour'],
    ['a greeting with the punctuation a phone adds', 'Bonjour!'],
    ['the bare yes that answers the consent question', 'oui'],
    ['the bare no that answers it the other way', 'Non'],
    ['a whole first message', "Bonjour, j'ai deux enfants, Lea 3 ans et Noah 5 ans"],
    ['a message with no unmistakable word, carried by function words', 'Je veux que vous surveillez les inscriptions'],
    ['an accented body a phone sent with its accents intact', 'Pouvez-vous nous aider avec la garderie?'],
    ['the same body with the accents stripped, as another phone sends it', 'Combien ca coute pour deux enfants'],
    ['the CASL French stop keyword, which Hale still has to recognise as French', 'ARRET'],
  ])('%s', (_case, body) => {
    expect(replyLanguage(body)).toBe('fr');
  });
});

describe('replyLanguage — everything else is English', () => {
  it.each([
    ['an ordinary intake reply', 'Maya is 4 and Leo is 2, M5V 3A8'],
    ['the QR prefill, which is machine-authored English', 'HALE LIBRARY'],
    ['the /text entry page prefill', 'Hi (via earlyon-georgetown)'],
    ['a CASL keyword', 'STOP'],
    ['a bare affirmative', 'yes'],
    ['an ordinary question', 'Can you help me find a daycare near High Park?'],
    ['an empty body', ''],
    ['a body with no letters at all', '👍'],
  ])('%s', (_case, body) => {
    expect(replyLanguage(body)).toBe('en');
  });

  /**
   * THE EXPENSIVE MISTAKE, and the reason accents alone can never decide this.
   *
   * A quarter of the names this product handles carry an accent — Chloe, Zoe, Loic,
   * Lea — and their parents overwhelmingly write English. An accent-triggered detector
   * would answer every one of them in French on the strength of their child's name,
   * which is both wrong and the exact moment (a first message, a consent moment) where
   * being wrong costs the most.
   */
  it('does not turn English French because a child has an accented name', () => {
    expect(replyLanguage('Chloé is 3 and Zoé is 5, we are in M4K')).toBe('en');
    expect(replyLanguage('Loïc turns 2 in March')).toBe('en');
  });

  /**
   * The words that had to be left OUT of the marker table, proven by the English
   * sentences that would otherwise have flipped. Each of these is a real French word
   * AND a real English one, so none of them can be evidence of anything.
   */
  it.each([
    ['Mon, the weekday abbreviation', 'Mon 3pm works for us'],
    ['EST, the timezone', 'Swim is at 5pm EST'],
    ['son and ton', "My son ate a ton of pasta"],
    ['a name that is also a French article', 'Les is 4 and starts school in September'],
    ['pour and comment, both ordinary English verbs', 'Can you comment on how much to pour?'],
  ])('%s', (_case, body) => {
    expect(replyLanguage(body)).toBe('en');
  });

  /** One marker is a coincidence; the rule is two. Stated as a test so the threshold
   * cannot be lowered without someone deciding to. */
  it('needs two markers, because one is how an English sentence looks by accident', () => {
    expect(replyLanguage('She has 3 ans of experience')).toBe('en');
    expect(replyLanguage('She is 3 ans et Noah is 5')).toBe('fr');
  });
});

/**
 * THE CORPUS, and the reason it exists rather than more unit cases.
 *
 * This is a word-list heuristic, and word-list heuristics fail ONE way: somebody adds a
 * useful-looking word that is also English, and a slice of ordinary traffic starts coming
 * back in the wrong language. No single unit test catches that — the offending word is
 * always in a sentence nobody thought to write down. So both directions are measured
 * against a body of messages this channel actually receives, and a failure names the
 * message rather than a count.
 *
 * The English half is the half that matters, and it is MUTATION-CHECKED rather than
 * merely written: adding `est`, `pour` and `son` back to FRENCH_MARKERS turns it red. An
 * earlier version of this corpus did NOT catch that — the two-marker rule absorbs a
 * single careless entry, so a corpus of ordinary sentences passes while the detector
 * quietly rots. The four dense sentences at the end of the list are what fixed it.
 */
describe('replyLanguage — measured against real traffic, both directions', () => {
  const ENGLISH = [
    'Hi there',
    'HALE LIBRARY',
    'Hi (via earlyon-georgetown)',
    'Maya is 4 and Leo is 2, M5V 3A8',
    'Chloé is 3 and Zoé is 5',
    'yes please',
    'no thanks',
    'STOP',
    'HELP',
    'START',
    'Can you help me find a daycare near High Park?',
    "what's the weather tomorrow",
    'My son fell off the couch and is crying',
    'she has a fever of 39 and a rash',
    "I don't want any more texts about swim",
    'Swim class is at 5pm EST on Mon and Wed',
    'We just moved to Toronto and need a family doctor',
    'Her name is Anne-Sophie and she is 6',
    'We live near Notre Dame, in Montreal',
    'The daycare is called Les Petits Amis',
    'Book an eye exam for Zoe please',
    'Ok sounds good, see you then',
    '2 kids, 3 and 6, L7G 4B9',
    'who is this',
    // The four below are the corpus's actual TEETH, and they are dense on purpose: each
    // packs several of the words the marker list had to exclude, so adding any TWO of
    // them back turns this red. A corpus of ordinary sentences would not — the
    // two-marker rule absorbs a single bad entry silently, which is precisely how a
    // careless addition would otherwise reach production.
    'Can you comment on how much formula to pour for my son?',
    'Swim is at 5pm EST and the car seat is in the main hall',
    'Mon and Tue work, but not Sat - a ton of stuff on the calendar',
    'Note the sale on her coat, plus the pain relief for her ear',
  ];

  const FRENCH = [
    'Bonjour',
    'Salut!',
    'Allo, je suis nouvelle ici',
    'oui',
    'Non',
    'Merci beaucoup',
    "Bonjour, j'ai deux enfants",
    'Mes enfants ont 4 et 2 ans, code postal H2X 1Y4',
    'Je cherche une garderie dans le quartier',
    'Pouvez-vous surveiller les inscriptions?',
    'Combien ca coute',
    'Pourquoi vous me textez',
    "Ma fille est tombee, qu'est-ce que je fais",
    'Je ne veux plus recevoir de messages',
    'ARRET',
    "C'est parfait, allez-y",
    'Quand est-ce que les inscriptions ouvrent',
  ];

  it('reads none of these English messages as French', () => {
    expect(ENGLISH.filter((body) => replyLanguage(body) !== 'en')).toEqual([]);
  });

  it('reads every one of these French messages as French', () => {
    expect(FRENCH.filter((body) => replyLanguage(body) !== 'fr')).toEqual([]);
  });
});
