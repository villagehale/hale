/**
 * WHAT LANGUAGE HALE ANSWERS IN, decided from the message in front of it and nothing
 * else.
 *
 * Hale already WRITES French — the coach and the general-answer skill both reply in the
 * language the parent wrote in (coach-channel-sms.md, general-answer.md), and the
 * deterministic yes/no table already READS it (affirmative.ts). What did not move was the
 * fixed copy: the greeting, the consent ask, the acknowledgments, the 811 line. Those are
 * the promises, and a francophone parent got every one of them in English — including the
 * very first sentence Hale ever says to them, and including the one they get when a
 * medical turn falls closed (medical.ts rejects a non-GSM-7 body, so an accented French
 * answer lands on the fixed safety line by construction).
 *
 * PER MESSAGE, NOT PER FAMILY, and that is a deliberate limit rather than a first cut at
 * a preference column. A remembered language is a stored fact about a person, which is a
 * privacy decision and a migration; this is a function of the text that just arrived, it
 * holds nothing, and it is wrong for exactly one turn when it is wrong. What it costs is
 * stated where it bites: the CASL keyword replies are triggered by the English tokens
 * STOP/HELP/START, so a body that IS one of those tokens carries no French evidence and
 * can never route to the French twin (see keywords.ts and the note on HELP_REPLY).
 *
 * IT DEFAULTS TO ENGLISH, always. Answering an anglophone in French is the expensive
 * error — it happens at first contact, it reads as a broken product rather than a
 * thoughtful one, and the parent has no way to correct it. Answering a francophone in
 * English is the status quo. So the rule below is built to be under-eager, and the two
 * tiers are two different standards of proof rather than a score.
 */

export type ReplyLanguage = 'en' | 'fr';

/**
 * Words that settle it alone.
 *
 * THE BAR: the word has no ordinary use in an English text message. Not "mostly French" —
 * a word that turns up in an English sentence at all belongs in the tier below, because
 * one appearance here is a whole message answered in the wrong language.
 *
 * That bar is what keeps `aide` out (an English noun), `mon` out (Monday), `est` out
 * (the timezone) and `pardon` out, and it is why the list is this short. `arret` is here
 * for a reason of its own: it is the French STOP keyword Canadian carriers require
 * (CTA CSC Compliance Policies v2.1 §3.1), and although `matchKeyword` does not yet act
 * on it, a parent who texts it has unmistakably written French.
 */
const FRENCH_ALONE = new Set([
  'bonjour',
  'bonsoir',
  'salut',
  'allo',
  'merci',
  'oui',
  'non',
  'svp',
  'stp',
  'cest',
  'jai',
  'daccord',
  'pourquoi',
  'combien',
  'arret',
]);

/**
 * Words that need a second one.
 *
 * THE BAR is weaker on purpose — these need only be words an English sentence does not
 * normally contain, because two of them together is the evidence, not one. That is what
 * lets the list carry the ordinary machinery of a French sentence (`je`, `vous`, `que`,
 * `avec`) without a single one of them being able to decide anything.
 *
 * WHAT IS DELIBERATELY ABSENT, because each is also an English word and would have
 * flipped a real message: `a`, `as`, `ai`, `on`, `or`, `ou`, `un`, `est`, `son`, `ton`,
 * `mon`, `ma`, `ta`, `sa`, `nos`, `car`, `pour`, `sans`, `plus`, `comment`, `encore`,
 * `main`, `pain`, `chat`, `coin`, `fin`, `but`, `part`, `note`, `sale`, `la`. The
 * accent-fold below is what makes them collide in the first place (`ou` and `où` are the
 * same token here), so the omissions have to be judged on the folded spelling.
 */
const FRENCH_MARKERS = new Set([
  // pronouns and determiners
  'je',
  'tu',
  'il',
  'elle',
  'ils',
  'elles',
  'vous',
  'nous',
  'mes',
  'tes',
  'ses',
  'votre',
  'vos',
  'notre',
  'leurs',
  'une',
  'des',
  'du',
  'le',
  'les',
  'aux',
  'cette',
  'cet',
  'ces',
  'celle',
  'celui',
  'ceux',
  // prepositions, conjunctions, adverbs
  'et',
  'avec',
  'dans',
  'sous',
  'sur',
  'chez',
  'vers',
  'depuis',
  'pendant',
  'apres',
  'avant',
  'mais',
  'donc',
  'alors',
  'aussi',
  'tres',
  'trop',
  'beaucoup',
  'toujours',
  'jamais',
  'deja',
  'maintenant',
  'demain',
  'hier',
  'ici',
  'ne',
  'pas',
  'rien',
  'tout',
  'tous',
  'toute',
  'toutes',
  'chaque',
  'plusieurs',
  // interrogatives
  'que',
  'qui',
  'quoi',
  'quand',
  'quel',
  'quelle',
  'quels',
  'quelles',
  // verbs
  'suis',
  'sont',
  'etait',
  'avez',
  'avons',
  'ont',
  'fait',
  'faire',
  'veux',
  'veut',
  'voulez',
  'peux',
  'peut',
  'pouvez',
  'dois',
  'doit',
  'sais',
  'sait',
  'dites',
  'dit',
  'aimerais',
  'voudrais',
  'besoin',
  // the nouns this product's messages are actually made of
  'enfant',
  'enfants',
  'garderie',
  'ecole',
  'semaine',
  'mois',
  'annee',
  'ans',
  'matin',
  'soir',
  'journee',
  'medecin',
  'sante',
  'naissance',
  'prenom',
  'aide',
]);

/**
 * A body reduced to the words it is made of, on the same two conventions
 * {@link normalizeReply} established next door (affirmative.ts): the accent is folded
 * onto its base letter so one table entry covers however a given phone spelled the word,
 * and the apostrophe is CLOSED UP rather than split on, which is what turns "j'ai" and
 * "c'est" into the single high-signal tokens `jai` and `cest` instead of the useless
 * fragments `j` and `c`.
 *
 * Digits and everything else fall out as separators. There is no stemming and no
 * scoring: a word either is in a table or it is not, which is what makes a wrong verdict
 * traceable to one line of one list.
 */
function words(body: string): string[] {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The language Hale's fixed copy should go out in for THIS message. English unless the
 * message proves otherwise — see the two bars above. */
export function replyLanguage(body: string): ReplyLanguage {
  const seen = new Set<string>();
  for (const word of words(body)) {
    if (FRENCH_ALONE.has(word)) return 'fr';
    if (FRENCH_MARKERS.has(word)) {
      seen.add(word);
      if (seen.size >= 2) return 'fr';
    }
  }
  return 'en';
}
