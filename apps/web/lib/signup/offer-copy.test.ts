import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIGNUP_OFFER_SENTENCE_FR, SIGNUP_OFFER_SENTENCE_TODO, signupTryOffer } from './offer-copy';

const DIR = fileURLToPath(new URL('.', import.meta.url));

describe('signup offer sentence', () => {
  it('is the locked offer and leaves only with a parent-approved price', () => {
    expect(SIGNUP_OFFER_SENTENCE_TODO).toBe(
      'It\'s {price}. Want me to try signing you up? I\'ll stop and hand it back if it asks for payment or a login.',
    );
    expect(SIGNUP_OFFER_SENTENCE_FR).toBe(
      "C'est {price}. Tu veux que j'essaie de t'inscrire? Je m'arrete et je te le remets si on demande un paiement ou une connexion.",
    );
    expect(SIGNUP_OFFER_SENTENCE_TODO).toMatch(/^[\x20-\x7E]+$/);
    expect(SIGNUP_OFFER_SENTENCE_FR).toMatch(/^[\x20-\x7E]+$/);
    expect(signupTryOffer({ language: 'en', price: '$40', priceApproved: false })).toEqual({
      body: 'It\'s $40. Want me to try signing you up? I\'ll stop and hand it back if it asks for payment or a login.',
      mayLeave: false,
    });
    expect(signupTryOffer({ language: 'en', price: '$40', priceApproved: true }).mayLeave).toBe(
      true,
    );
    expect(signupTryOffer({ language: 'fr', price: '40 $', priceApproved: true }).body).toBe(
      "C'est 40 $. Tu veux que j'essaie de t'inscrire? Je m'arrete et je te le remets si on demande un paiement ou une connexion.",
    );
    const files = readdirSync(DIR).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'offer-copy.ts',
    );
    expect(files).toContain('run.ts');
    expect(files).toContain('copy.ts');
    for (const name of files) {
      const source = readFileSync(`${DIR}${name}`, 'utf8');
      expect(source, name).not.toContain('TODO-Design');
      expect(source, name).not.toContain(SIGNUP_OFFER_SENTENCE_TODO);
    }
  });
});