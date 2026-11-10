/**
 * The cancelled locked offer sentence (VIL-396 / VIL-397).
 *
 * It must not be sent. Production offers are written from facts by
 * `offer-writer.ts` (skill `signup-offer`) and recorded by `offerSignupFromFacts`.
 */

import { copyLanguage } from '~/lib/channel/language';

export const SIGNUP_OFFER_SENTENCE_TODO =
  "It's {price}. Want me to try signing you up? I'll stop and hand it back if it asks for payment or a login.";

export const SIGNUP_OFFER_SENTENCE_FR =
  "C'est {price}. Tu veux que j'essaie de t'inscrire? Je m'arrete et je te le remets si on demande un paiement ou une connexion.";

/** Leaves only when the parent already approved this price, and only in English or French. */
export function signupTryOffer(input: {
  language: string;
  price: string;
  priceApproved: boolean;
}): { body: string; mayLeave: boolean } {
  const key = copyLanguage(input.language);
  if (!key) return { body: '', mayLeave: false };
  const pattern = key === 'fr' ? SIGNUP_OFFER_SENTENCE_FR : SIGNUP_OFFER_SENTENCE_TODO;
  const body = pattern.replaceAll('{price}', input.price);
  const mayLeave = input.priceApproved && input.price.trim().length > 0 && !body.includes('{');
  return { body, mayLeave };
}
