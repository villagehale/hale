import { replyLanguage } from '~/lib/channel/language';
import { IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE } from './copy';

/**
 * VIL-333 — an identity or distrust challenge, detected without a model.
 *
 * The live miss (2026-08-28) was a police-officer demand for a name and address.
 * Hale answered with an improvised "I'm an AI" sentence and then pivoted back to
 * the watch ask. The disclosure is a promise, so the reply is the locked string
 * in {@link IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE} and the turn ends there.
 *
 * HIGH PRECISION ON PURPOSE. A parent asking for a pool address, a teacher's
 * name, or who won something is not challenging Hale. The patterns below require
 * the subject to be the sender (you / this number), a second-person demand for
 * Hale's own name or address, a scam fear aimed at this thread, or a first-person
 * authority claim that is not also a family-details text.
 */

/** Ledger stamp for the router send. The body itself stays off the row (rule #1). */
export const IDENTITY_CHALLENGE_TEMPLATE_KEY = 'identity_challenge';

/**
 * Folded the same way {@link replyLanguage} folds: accents off, apostrophes closed
 * so "who's" and "I'm" and "c'est" are one spelling each. Digits stay, because an
 * age or a postal code is evidence this is intake rather than a bare authority claim.
 */
function fold(body: string): string {
  return body
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/['’ʼ`]/g, '')
    .replace(/[^a-z0-9@]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Who are you / who is this / qui etes-vous" — the subject is the sender. */
const WHO =
  /\bwho(?:s| is| are| r) (?:you|u)\b|\bwho(?:s| is) this(?! for\b)|\bwho(?:s| is) that\b(?! \w)|\bwho am i (?:talking|texting|speaking|messaging) (?:to|with)\b|\bwho(?:s| is) (?:texting|messaging|calling) (?:me|us)\b|\bwho(?:s| is) behind\b|\bwho (?:runs|owns|operates) (?:this|you|hale)\b|\bwhat (?:company|business) (?:is this|are you)\b|\bqui (?:es tu|etes vous|est ce|est derriere)\b|\bcest qui\b|\bvous etes qui\b|\btes qui\b|\bqui (?:mecrit|menvoie|envoie)\b/;

/** Bot / scam / legitimacy, aimed at this thread rather than at a program. */
const SUSPICION =
  /\b(?:are you|r u|youre|you are|is this|this is) (?:a |an )?(?:real person|real human|bot|robot|scam|scammer|fake|spam|ai|human|person|legit|legitimate)\b|\bare you real\b|\b(?:dont|do not) trust (?:you|this number|these texts|this text|this message)\b|\b(?:dont|do not) trust this$|\bprove (?:youre|you are|this is) (?:real|legit)\b|\b(?:feels|seems|smells) like (?:a )?(?:scam|spam|phishing|fraud)\b|\btrying to scam\b|\b(?:scam|scamming|phishing) (?:me|us)\b|\b(?:cest|vous etes|tu es) (?:une? )?arnaque\b/;

/** A demand for Hale's name, address, or identity — second person, not a venue's. */
const DEMAND =
  /\b(?:give|send|provide|tell|state|whats|what is) (?:me )?(?:your|ur) (?:full |legal |real |business |company |mailing )?(?:name|address|identity)\b|\byour (?:full |legal |business |company |mailing )(?:name|address)\b|\bidentify yourself\b|\b(?:votre|ton) (?:nom|adresse)\b|\b(?:donnez|donne|donner) (?:moi )?(?:votre|ton) (?:nom|adresse)\b|\bquel est votre nom\b/;

/**
 * First person, or "this is the police". "my lawyer" and "the police station"
 * do not match: those are about someone else.
 */
const AUTHORITY =
  /\b(?:im|i am|this is) (?:a |an |the |with the |with )?(?:police officer|police|cop|detective|constable|rcmp|opp|lawyer|attorney|solicitor|barrister|law enforcement)\b|\bje suis (?:un |une )?(?:policier|policiere|avocat|avocate|detective|enqueteur|enqueteuse)\b|\bcest la police\b/;

function bareAuthorityClaim(text: string): boolean {
  if (!AUTHORITY.test(text)) return false;
  if (WHO.test(text) || SUSPICION.test(text) || DEMAND.test(text)) return true;
  const rest = text
    .replace(AUTHORITY, ' ')
    .replace(/\b(?:please|thanks|thank you|now|asap|sir|maam)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // An age, a postal code, or a real question riding along is intake, not a challenge.
  if (rest.length > 24) return false;
  if (/\b\d/.test(text)) return false;
  if (/\b[a-z]\d[a-z]\b/.test(text)) return false;
  return true;
}

/** True when this inbound is challenging who Hale is, rather than asking Hale to do its job. */
export function isIdentityChallenge(body: string): boolean {
  const text = fold(body);
  if (text === '') return false;
  return WHO.test(text) || SUSPICION.test(text) || DEMAND.test(text) || bareAuthorityClaim(text);
}

/**
 * The locked disclosure for this inbound, or null when it is not a challenge.
 * Language is the existing per-message {@link replyLanguage} read — English unless
 * the words prove French.
 */
export function identityChallengeReply(body: string): string | null {
  if (!isIdentityChallenge(body)) return null;
  return IDENTITY_ACCOUNTABILITY_LINE_BY_LANGUAGE[replyLanguage(body)];
}
