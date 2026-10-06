import { describe, expect, it } from 'vitest';
import { type OfferReceiptFacts, offerReceiptAccepts, writeOfferReceipt } from './offer-receipt';

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
});
