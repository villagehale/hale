/**
 * Group onboarding v2 — what a member said they are, read from their own reply.
 *
 * Pure. Code reads the clear cases with en/fr cues; no model reads a reply, because the
 * reading decides the seat. A reply that names two roles, negates one, or names a step
 * relation is `unclear`, never a guess, and gets the one re-ask.
 */

export const ROSTER_ROLES = [
  'parent',
  'grandparent',
  'nanny',
  'babysitter',
  'not_family',
  'decline',
] as const;
export type RosterRole = (typeof ROSTER_ROLES)[number];

export type RosterParentRole = 'mother' | 'father' | null;

export type RosterReading =
  | { kind: 'role'; role: RosterRole; parentRole: RosterParentRole }
  | { kind: 'unclear' };

const GRANDPARENT =
  /\b(?:grand[- ]?(?:ma|pa|mom|mum|dad|mother|father|parent|maman|papa|mere|pere)s?|grann(?:y|ie)|gran|gramma|grammy|nana|nanna|nonna|nonno|mamie|mamy|papi|papy|meme|pepe)\b/g;
/** A step-parent or in-law could be a parent or a grandparent; only they can say which. */
const STEP =
  /\b(?:step[- ]?(?:mom|mum|mother|dad|father|parent)|(?:mom|mum|mother|dad|father|parent)s?[- ]in[- ]law|belle[- ]mere|beau[- ]pere)\b/;
/** "their dad's girlfriend", "la copine du papa": a parent word about someone else. */
const SOMEONE_ELSES_PARENT =
  /\b(?:mom|mum|mommy|mama|mother|dad|daddy|father|papa|maman)'s\b|\b(?:du|de la|de l') ?(?:papa|maman|pere|mere)\b/;
const MOTHER = /\b(?:mom|mum|mommy|mummy|momma|mama|mother|maman|mere)\b/;
const FATHER = /\b(?:dad|daddy|father|papa|pere)\b/;
const PARENT = /\b(?:co-?parent|parent)\b/;
const NANNY = /\b(?:nann(?:y|ie)|nounou|au[- ]pair|nourrice)\b/;
const SITTER = /\b(?:baby-?sitter|sitter|gardienne|gardien)\b/;
const NOT_FAMILY =
  /\b(?:not (?:family|part of the family|related)|pas (?:de|dans) la famille|friend|ami|amie|aunt|auntie|aunty|uncle|tante|oncle|tata|tonton|neighbou?r|voisin|voisine|cousin|cousine)\b/;
const DECLINE_WHOLE =
  /^(?:no|nope|nah|no thanks|no thank you|non|non merci|pass|not interested|pas interessee?)$/;
const DECLINE_ANYWHERE =
  /\b(?:leave me out|count me out|not for me|rather not|laisse[- ]moi (?:en dehors|tranquille)|sans moi)\b/;
const NEGATION = /\b(?:not|never|pas|jamais)\b|n't\b/;
/** A role word in a longer sentence counts only when the sentence is about the speaker. */
const ABOUT_SELF = /\b(?:i'?m|i am|it'?s|this is|here|me|c'est|je suis|moi|ici)\b/;
const SHORT_REPLY_WORDS = 4;

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function role(value: RosterRole, parentRole: RosterParentRole = null): RosterReading {
  return { kind: 'role', role: value, parentRole };
}

const UNCLEAR: RosterReading = { kind: 'unclear' };

export function readRosterReply(text: string): RosterReading {
  const said = normalize(text);
  const bare = said.replace(/[^\p{L}\p{N}' -]/gu, '').trim();
  if (DECLINE_WHOLE.test(bare) || DECLINE_ANYWHERE.test(said)) return role('decline');
  if (STEP.test(said) || SOMEONE_ELSES_PARENT.test(said)) return UNCLEAR;

  const grandparent = GRANDPARENT.test(said);
  GRANDPARENT.lastIndex = 0;
  const rest = said.replace(GRANDPARENT, ' ');
  const mother = MOTHER.test(rest);
  const father = FATHER.test(rest);
  const candidates: RosterRole[] = [];
  if (grandparent) candidates.push('grandparent');
  if (mother || father || PARENT.test(rest)) candidates.push('parent');
  if (NANNY.test(said)) candidates.push('nanny');
  if (SITTER.test(said)) candidates.push('babysitter');
  const notFamily = NOT_FAMILY.test(said);
  if (notFamily) candidates.push('not_family');

  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!only) return UNCLEAR;
  if (only !== 'not_family' && NEGATION.test(said)) return UNCLEAR;
  const short = bare.split(' ').filter(Boolean).length <= SHORT_REPLY_WORDS;
  if (only !== 'not_family' && !short && !ABOUT_SELF.test(said)) return UNCLEAR;
  if (only === 'parent') {
    if (mother && father) return UNCLEAR;
    return role('parent', mother ? 'mother' : father ? 'father' : null);
  }
  return role(only);
}
