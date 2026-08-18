import { describe, expect, it } from 'vitest';
import { replyLanguage } from '~/lib/channel/language';
import {
  ANSWER_UNAVAILABLE_REPLY,
  ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE,
  PROVIDER_ACCESS_REPLY,
  PROVIDER_ACCESS_REPLY_BY_LANGUAGE,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
  reachesForTheHealthLine,
} from './copy';

/**
 * The French twins of the three lines this lane can send without a model.
 *
 * The safety line is the one that matters most here, and not only because of what it
 * says: a French medical turn falls closed onto it BY CONSTRUCTION. `medical.ts` refuses
 * any composed body that is not GSM-7, and a real French answer carries accents the
 * alphabet cannot always take — so the fixed line is what a francophone parent asking
 * about a hurt child is most likely to actually receive.
 *
 * PENDING FOUNDER REVIEW, all three, plus the two proper nouns called out below.
 */
describe('the French off-domain lines', () => {
  /**
   * TWO PROPER NOUNS NEED VERIFYING BEFORE THIS SHIPS, and they are asserted verbatim so
   * the review has something to sign off on rather than a paraphrase:
   *
   *   "Santé811" — the French face of Ontario's Health811 service.
   *   "Accès Soins" — the French name of Health Care Connect.
   *
   * Both were written from the same primary sources the English lines cite, but neither
   * was re-fetched in this change. The NUMBER is what a parent dials either way, and the
   * number is the same in both languages, which is what keeps a wrong name from being a
   * dangerous one.
   */
  it('gives the safety answer in French, with both numbers intact', () => {
    expect(SAFETY_REPLY_BY_LANGUAGE.fr).toBe(
      "Ce n'est pas à moi de vous conseiller là-dessus. Santé811 (composez le 811) peut vous aider à toute heure - et en cas d'urgence, faites le 911.",
    );
    // The two numbers are the whole message. A translation that dropped one would be the
    // worst defect in this file.
    expect(SAFETY_REPLY_BY_LANGUAGE.fr).toContain('811');
    expect(SAFETY_REPLY_BY_LANGUAGE.fr).toContain('911');
    // It stays a referral, not a reassurance: Hale cannot see the child, so it must not
    // say anything that sounds like a clinical judgement, and it asks nothing back.
    expect(SAFETY_REPLY_BY_LANGUAGE.fr).not.toContain('?');
  });

  /**
   * The tripwire that substitutes the reviewed safety line for any MODEL body naming 811
   * or 911 has to keep firing on the French one. It matches on the digits rather than on
   * English words, so it does — pinned here because a French line that slipped past it
   * would be a composed siren going out unreviewed.
   */
  it('is still recognised as the health line by the tripwire that guards it', () => {
    expect(reachesForTheHealthLine(SAFETY_REPLY_BY_LANGUAGE.fr)).toBe(true);
    // Positive control through the same reader, and its negative: an ordinary French
    // sentence is not a siren.
    expect(reachesForTheHealthLine(SAFETY_REPLY)).toBe(true);
    expect(reachesForTheHealthLine('Le cours de natation est a 9h11')).toBe(false);
  });

  it('says in French that the answer could not be written, and offers the retry', () => {
    expect(ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE.fr).toBe(
      "Mes excuses - je n'ai pas réussi à répondre à celle-là. Réessayez dans une minute.",
    );
    // The honest shape: it says what happened, it is not a claim about a boundary Hale
    // does not have, and it points at no app and no link.
    expect(ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE.fr).not.toMatch(/https?:/i);
  });

  it('names the Ontario registry and the number that registers you, in French', () => {
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr).toBe(
      "Trouver un médecin pour vous, je ne peux pas - mais Accès Soins est la liste de l'Ontario pour un médecin de famille ou un pédiatre, et on s'y inscrit en composant le 811. Ce numéro répond aussi aux questions de santé à toute heure.",
    );
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr).toContain('811');
    // No clinic names, no URLs, no wait-time estimates — the same three things the
    // English line refuses to invent.
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr).not.toMatch(/https?:|\.ca\b|\.com\b/);
  });

  it('holds the English constant itself, so the two can never drift apart', () => {
    expect(SAFETY_REPLY_BY_LANGUAGE.en).toBe(SAFETY_REPLY);
    expect(ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE.en).toBe(ANSWER_UNAVAILABLE_REPLY);
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE.en).toBe(PROVIDER_ACCESS_REPLY);
  });

  it('routes a French question to the French line and everything else to the English one', () => {
    const french = "Mon fils est tombé, je ne sais pas quoi faire";
    const english = 'my son fell off the couch, what do I do';

    expect(SAFETY_REPLY_BY_LANGUAGE[replyLanguage(french)]).toBe(SAFETY_REPLY_BY_LANGUAGE.fr);
    expect(SAFETY_REPLY_BY_LANGUAGE[replyLanguage(english)]).toBe(SAFETY_REPLY);
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE[replyLanguage('Je cherche un medecin de famille')]).toBe(
      PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr,
    );
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE[replyLanguage('looking for a family doctor')]).toBe(
      PROVIDER_ACCESS_REPLY,
    );
  });
});
