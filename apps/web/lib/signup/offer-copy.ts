/**
 * The sentence that offers to try a signup (VIL-397).
 *
 * It may leave only when the parent has already approved the price. Nothing
 * in the signup path interpolates it into a reply. The signup flag stays off.
 */

export const SIGNUP_OFFER_SENTENCE_TODO =
  'It\'s {price}. Want me to try signing you up? I\'ll stop and hand it back if it asks for payment or a login.';

export const SIGNUP_OFFER_SENTENCE_FR =
  "C'est {price}. Tu veux que j'essaie de t'inscrire? Je m'arrete et je te le remets si on demande un paiement ou une connexion.";

/** Leaves only when the parent already approved this price. */
export function signupTryOffer(input: {
  language: 'en' | 'fr';
  price: string;
  priceApproved: boolean;
}): { body: string; mayLeave: boolean } {
  const pattern = input.language === 'fr' ? SIGNUP_OFFER_SENTENCE_FR : SIGNUP_OFFER_SENTENCE_TODO;
  const body = pattern.replaceAll('{price}', input.price);
  const mayLeave = input.priceApproved && input.price.trim().length > 0 && !body.includes('{');
  return { body, mayLeave };
}
