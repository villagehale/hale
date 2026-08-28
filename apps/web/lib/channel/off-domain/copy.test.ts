import { describe, expect, it } from 'vitest';
import { replyLanguage } from '~/lib/channel/language';
import {
  ANSWER_UNAVAILABLE_REPLY,
  ANSWER_UNAVAILABLE_REPLY_BY_LANGUAGE,
  DIRECT_ACCESS_EYE_REPLY,
  PROVIDER_ACCESS_REPLY,
  PROVIDER_ACCESS_REPLY_BY_LANGUAGE,
  SAFETY_REPLY,
  SAFETY_REPLY_BY_LANGUAGE,
  UNPLACEABLE_PROVIDER_REPLY,
  UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE,
  namesAMentalCrisis,
  reachesForTheHealthLine,
  referralReply,
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
describe('mental-crisis tripwire · VIL-327', () => {
  it('fires on suicide / self-harm and leaves care-find and cheer-up alone', () => {
    expect(namesAMentalCrisis('I want to die')).toBe(true);
    expect(namesAMentalCrisis('thinking about suicide')).toBe(true);
    expect(namesAMentalCrisis('self-harm tonight')).toBe(true);
    expect(namesAMentalCrisis('I need a therapist')).toBe(false);
    expect(namesAMentalCrisis('cheer me up')).toBe(false);
  });
});

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
    const french = 'Mon fils est tombé, je ne sais pas quoi faire';
    const english = 'my son fell off the couch, what do I do';

    expect(SAFETY_REPLY_BY_LANGUAGE[replyLanguage(french)]).toBe(SAFETY_REPLY_BY_LANGUAGE.fr);
    expect(SAFETY_REPLY_BY_LANGUAGE[replyLanguage(english)]).toBe(SAFETY_REPLY);
    expect(
      PROVIDER_ACCESS_REPLY_BY_LANGUAGE[replyLanguage('Je cherche un medecin de famille')],
    ).toBe(PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr);
    expect(PROVIDER_ACCESS_REPLY_BY_LANGUAGE[replyLanguage('looking for a family doctor')]).toBe(
      PROVIDER_ACCESS_REPLY,
    );
  });
});

/**
 * VIL-295 · the referral table.
 *
 * The live defect (founder's own thread, 2026-08-13 03:15): "Find a optometrist near me"
 * was answered with Health Care Connect, which places family doctors and nurse
 * practitioners and has never placed an optometrist. The eye branch fixed that ONE ask
 * and left the shape underneath it — a two-way if/else whose DEFAULT was the registry —
 * so every other practitioner a parent can name (a paediatric dentist, an OT, a speech
 * therapist, an audiologist, a physio, a child psychologist) got the same confidently
 * wrong answer. The classifier even has a `specialist-access` bucket for exactly those.
 *
 * A table with a MISS branch is the fix: a service Hale has verified an access path for
 * gets that path, and one it has not gets told so. Honest ignorance is a correct answer;
 * a registry that will never call you back is not.
 */
describe('the provider referral table', () => {
  it('sends an eye-care ask to the direct-access answer, not the registry', () => {
    for (const ask of [
      'Find a optometrist near me',
      'when should he get an eye exam',
      'need to get her eyes checked before school',
    ]) {
      expect(referralReply(ask, 'en')).toBe(DIRECT_ACCESS_EYE_REPLY);
    }
  });

  it('sends a primary-care ask to Health Care Connect', () => {
    for (const ask of [
      'we just moved and need a family doctor',
      'how do I find a pediatrician',
      'looking for a nurse practitioner',
    ]) {
      expect(referralReply(ask, 'en')).toBe(PROVIDER_ACCESS_REPLY);
    }
  });

  /**
   * THE INCIDENT CLASS, and the one this table exists for. Every ask below is a real
   * `specialist-access` bucket, none of them is placed by Health Care Connect, and on
   * main every single one received its line.
   */
  it('never answers an unplaceable specialist with the registry', () => {
    for (const ask of [
      'can you find us a pediatric dentist',
      'we need an OT for my son',
      'looking for a speech therapist for my 3 year old',
      'how do I get a childrens audiologist',
      'need a physiotherapist for her ankle',
      'trying to find a child psychologist',
    ]) {
      expect(referralReply(ask, 'en')).not.toBe(PROVIDER_ACCESS_REPLY);
      expect(referralReply(ask, 'en')).toBe(UNPLACEABLE_PROVIDER_REPLY);
    }
  });

  /** A refusal that names no adjacent can is the shape the capability table forbids. */
  it('says it does not know, and names what Hale can still do', () => {
    expect(UNPLACEABLE_PROVIDER_REPLY).not.toMatch(/health care connect/i);
    expect(UNPLACEABLE_PROVIDER_REPLY).not.toMatch(/https?:|\.ca\b|\.com\b/);
    expect(UNPLACEABLE_PROVIDER_REPLY).not.toMatch(/\bthe app\b|settings/i);
    expect(UNPLACEABLE_PROVIDER_REPLY).toMatch(/calendar|week/i);
  });

  it('answers a French provider ask in French on every branch it has one for', () => {
    expect(referralReply('Je cherche un medecin de famille', 'fr')).toBe(
      PROVIDER_ACCESS_REPLY_BY_LANGUAGE.fr,
    );
    expect(referralReply('je cherche un orthophoniste pour mon fils', 'fr')).toBe(
      UNPLACEABLE_PROVIDER_REPLY_BY_LANGUAGE.fr,
    );
  });
});
