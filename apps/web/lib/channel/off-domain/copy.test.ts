import { describe, expect, it } from 'vitest';
import { reachesForTheHealthLine, referralReply } from './copy';

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
  it('recognises a health-line number in a model-written body, in either language', () => {
    expect(reachesForTheHealthLine('faites le 911')).toBe(true);
    expect(reachesForTheHealthLine('call 811')).toBe(true);
    expect(reachesForTheHealthLine('Le cours de natation est a 9h11')).toBe(false);
  });

  it('names the Ontario registry and the number that registers you, in French', async () => {
    const fr = await referralReply('Je cherche un medecin de famille', 'fr');
    expect(fr).toContain('811');
    expect(fr).not.toBe(await referralReply('we need a family doctor', 'en'));
    // No clinic names, no URLs, no wait-time estimates — the same three things the
    // English line refuses to invent.
    expect(fr).not.toMatch(/https?:|\.ca\b|\.com\b/);
  });

  it('writes a line for every tag, including one the product does not author in', async () => {
    const zh = await referralReply('Je cherche un medecin de famille', 'zh');
    expect(zh).toBeTruthy();
    expect(zh).toContain('Health Care Connect');
    expect(zh).toContain('811');
    expect(await referralReply('we need a family doctor', null)).toBeTruthy();
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
  it('sends an eye-care ask to the direct-access answer, not the registry', async () => {
    for (const ask of [
      'Find a optometrist near me',
      'when should he get an eye exam',
      'need to get her eyes checked before school',
    ]) {
      const reply = await referralReply(ask, 'en');
      expect(reply).toContain('FindAnEyeDoctor.ca');
      expect(reply).not.toContain('811');
      expect(reply).not.toContain('Health Care Connect');
    }
  });

  it('sends a primary-care ask to Health Care Connect', async () => {
    for (const ask of [
      'we just moved and need a family doctor',
      'how do I find a pediatrician',
      'looking for a nurse practitioner',
    ]) {
      const reply = await referralReply(ask, 'en');
      expect(reply).toContain('Health Care Connect');
      expect(reply).toContain('811');
    }
  });

  /**
   * THE INCIDENT CLASS, and the one this table exists for. Every ask below is a real
   * `specialist-access` bucket, none of them is placed by Health Care Connect, and on
   * main every single one received its line.
   */
  it('never answers an unplaceable specialist with the registry', async () => {
    for (const ask of [
      'can you find us a pediatric dentist',
      'we need an OT for my son',
      'looking for a speech therapist for my 3 year old',
      'how do I get a childrens audiologist',
      'need a physiotherapist for her ankle',
      'trying to find a child psychologist',
    ]) {
      const reply = await referralReply(ask, 'en');
      expect(reply).not.toContain('Health Care Connect');
      expect(reply).not.toContain('811');
      expect(reply).toBeTruthy();
    }
  });

  /** A refusal that names no adjacent can is the shape the capability table forbids. */
  it('says it does not know, and names what Hale can still do', async () => {
    const reply = await referralReply('we need an OT for my son', 'en');
    expect(reply).not.toMatch(/health care connect/i);
    expect(reply).not.toMatch(/https?:|\.ca\b|\.com\b/);
    expect(reply).not.toMatch(/\bthe app\b|settings/i);
    expect(reply).toMatch(/calendar|week/i);
  });

  it('answers a French provider ask in French on every branch it has one for', async () => {
    const family = await referralReply('Je cherche un medecin de famille', 'fr');
    expect(family).toContain('811');
    expect(family).not.toBe(await referralReply('we need a family doctor', 'en'));
    const other = await referralReply('je cherche un orthophoniste pour mon fils', 'fr');
    expect(other).not.toContain('Health Care Connect');
    expect(other).not.toContain('811');
    expect(other).not.toBe(await referralReply('we need an OT for my son', 'en'));
  });
});
