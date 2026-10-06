import { describe, expect, it } from 'vitest';
import { type OfferReceiptFacts, offerReceiptAccepts, writeOfferReceipt } from './offer-receipt';
import { foldOutboundLine } from './outbound-line';

const FACTS: OfferReceiptFacts = {
  kind: 'added',
  title: 'Gymnastics',
  whenLabel: 'Sunday, Oct 4 at 9:00 a.m.',
  language: 'en',
};

const GOOD = 'Gymnastics is on your week, Sunday, Oct 4 at 9:00 a.m. Tell me if you want it off.';

describe('writeOfferReceipt', () => {
  it('sends the first line that names the occasion', async () => {
    const pages: string[] = [];
    const line = await writeOfferReceipt(FACTS, {
      attempt: async () => GOOD,
      alert: async (text) => {
        pages.push(text);
      },
    });
    expect(line).toBe(GOOD);
    expect(pages).toEqual([]);
  });

  it('retries once after a line about a different day, then sends the good one', async () => {
    const seen: number[] = [];
    const line = await writeOfferReceipt(FACTS, {
      attempt: async (_facts, tryIndex) => {
        seen.push(tryIndex);
        return tryIndex === 0 ? 'Gymnastics was Thursday, Oct 1 at 4:15 p.m.' : GOOD;
      },
      alert: async () => undefined,
    });
    expect(seen).toEqual([0, 1]);
    expect(line).toBe(GOOD);
    expect(offerReceiptAccepts(GOOD, FACTS)).toBe(true);
  });

  it('sends nothing and pages ops when both attempts miss', async () => {
    const pages: string[] = [];
    const line = await writeOfferReceipt(FACTS, {
      attempt: async () => 'Okay - left it off.',
      alert: async (text) => {
        pages.push(text);
      },
    });
    expect(line).toBeNull();
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('unsent after retry');
    expect(pages[0]).not.toContain('Gymnastics');
  });

  it('folds an accent and a curly apostrophe, then sends that line', async () => {
    const raw = "J'ai ajouté Gymnastics de côté, Sunday, Oct 4 at 9:00 a.m.";
    const line = await writeOfferReceipt(FACTS, {
      attempt: async () => raw,
      alert: async () => undefined,
    });
    expect(line).toBe("J'ai ajouté Gymnastics de coté, Sunday, Oct 4 at 9:00 a.m.");
    expect(foldOutboundLine('Fête')).toBe('Fete');
    expect(foldOutboundLine('Children\u2019s Theatre')).toBe("Children's Theatre");
  });
});

const FR: OfferReceiptFacts = {
  ...FACTS,
  language: 'fr',
  whenLabel: 'dimanche 4 oct. à 9 h',
};

describe('offerReceiptAccepts', () => {
  it('accepts a French line that copies the French date', () => {
    expect(
      offerReceiptAccepts(
        "C'est noté, Gymnastics, dimanche 4 oct. à 9 h. Dis-moi pour l'enlever.",
        FR,
      ),
    ).toBe(true);
  });

  it('refuses an English date, another weekday, and another calendar day', () => {
    expect(offerReceiptAccepts("J'ai ajouté Gymnastics le Sunday, Oct 4 at 9:00 a.m.", FR)).toBe(
      false,
    );
    expect(offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h, aussi jeudi.', FR)).toBe(false);
    expect(offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h et le 5 octobre.', FR)).toBe(
      false,
    );
  });

  it('refuses a French keyword ask, an all-caps token, and a co-parent', () => {
    const base = 'Gymnastics, dimanche 4 oct. à 9 h.';
    expect(offerReceiptAccepts(`${base} Écris OUI pour le garder.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} Texte NON.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} Dis NON.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} écris oui pour le garder.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} Écris oui.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} réponds OUI.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} texte NON.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} dis NON.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} aussi jeu.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} aussi mar.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} et le 13/10.`, FR)).toBe(false);
    expect(offerReceiptAccepts(`${base} le 04/10.`, FR)).toBe(false);
    expect(
      offerReceiptAccepts('Say STOP REMOVE. Gymnastics is on Sunday, Oct 4 at 9:00 a.m.', FACTS),
    ).toBe(false);
    expect(
      offerReceiptAccepts(
        'Gymnastics was already on their week, Sunday, Oct 4 at 9:00 a.m.',
        FACTS,
      ),
    ).toBe(false);
    expect(
      offerReceiptAccepts("Gymnastics, dimanche 4 oct. à 9 h, la semaine de l'autre parent.", FR),
    ).toBe(false);
    expect(offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h, leur semaine.', FR)).toBe(false);
    expect(
      offerReceiptAccepts('I added Gymnastics on Sunday, Oct 4 at 9:00 a.m. to my week.', FACTS),
    ).toBe(false);
    expect(
      offerReceiptAccepts('I added Gymnastics on Sunday, Oct 4 at 9:00 a.m. to our week.', FACTS),
    ).toBe(false);
    expect(
      offerReceiptAccepts(
        'I added Gymnastics on Sunday, Oct 4 at 9:00 a.m. to my calendar.',
        FACTS,
      ),
    ).toBe(false);
    expect(offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h, sur ma semaine.', FR)).toBe(
      false,
    );
    expect(offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h, sur notre semaine.', FR)).toBe(
      false,
    );
    expect(
      offerReceiptAccepts('Gymnastics, dimanche 4 oct. à 9 h, sur notre calendrier.', FR),
    ).toBe(false);
    expect(offerReceiptAccepts(GOOD, FACTS)).toBe(true);
    expect(offerReceiptAccepts('Gymnastics est sur ta semaine, dimanche 4 oct. à 9 h.', FR)).toBe(
      true,
    );
    expect(
      offerReceiptAccepts(
        'Gymnastics was already on your week, Sunday, Oct 4 at 9:00 a.m. - let me know if you want it removed.',
        FACTS,
      ),
    ).toBe(false);
  });
});
