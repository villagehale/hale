import { describe, expect, it } from 'vitest';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';
import { FAQ, faqJsonLd } from './index';

describe('product FAQ', () => {
  it('every item has a non-empty question and answer', () => {
    expect(FAQ.length).toBeGreaterThan(0);
    for (const item of FAQ) {
      expect(item.question.trim().length).toBeGreaterThan(0);
      expect(item.answer.trim().length).toBeGreaterThan(0);
    }
  });

  it('faqJsonLd is a FAQPage with one Question per item', () => {
    const ld = faqJsonLd();
    expect(ld['@type']).toBe('FAQPage');
    const entities = ld.mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(FAQ.length);
    for (const q of entities) {
      expect(q['@type']).toBe('Question');
      expect((q.acceptedAnswer as { '@type': string })['@type']).toBe('Answer');
    }
  });
});

describe('the FAQ this build serves', () => {
  it('describes a number you text rather than an app you sign up for', () => {
    const answers = FAQ
      .map((item) => item.answer)
      .join(' ');
    expect(answers).toContain('text');
    expect(answers).toContain('no account to create');
    // The homepage offers no signup and nothing to browse, so the FAQ must not
    // re-open that door or sell the village of local activities it replaced.
    // The bot-or-not answer names aloha@villagehale.com — the accountability
    // address, not the metaphor — so the domain is stripped before asserting.
    expect(answers).not.toContain('sign up');
    expect(answers.replaceAll('villagehale.com', '')).not.toContain('village');
  });

  it('keeps every claim inside what ships — no named method, no outcome promise', () => {
    const all = FAQ
      .map((item) => `${item.question} ${item.answer}`)
      .join(' ');
    for (const overclaim of ['Ferber', 'guaranteed', 'will fix', 'March break', 'PA day']) {
      expect(all).not.toContain(overclaim);
    }
    expect(all).toContain('never diagnoses and never names a dose');
  });

  it('offers the record by a door a texting family has (claim-by-phone must ship first)', () => {
    // Same merge-order dependency as the landing's receipts line: web sign-in is
    // Google + magic link today, and a texted family has no email address.
    const answers = FAQ
      .map((item) => item.answer)
      .join(' ');
    expect(answers).toContain('sign in with your phone number');
  });

  it('scopes the never-texts-first promise to what CASL actually buys the reader', () => {
    // "Hale never texts you first" was flatly false three questions later, where
    // the same page describes the Sunday week plan and the registration heads-up —
    // both real, both default-on (loop_prefs.catWeeklyPlan). The promise a parent
    // is owed is that Hale never COLD-texts: an unknown number is never messaged.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).not.toContain('never texts you first');
    expect([...answers.matchAll(/never texts a number that hasn’t texted it first/g)]).toHaveLength(
      2,
    );
    // Positive control: the proactive brief the old claim contradicted is still
    // described, so this passes because the claim was scoped, not because the
    // page went quiet about what Hale sends.
    expect(answers).toContain('A brief on Sunday');
    expect(answers).not.toContain('A brief on Monday');
    expect(answers).not.toContain('Monday morning');
  });

  it('reaches consent and privacy inside the top four questions', () => {
    // Risk → time → money. They were Q6 and Q9 of 11, below the fold and behind
    // closed disclosures, on a product whose stated moat is privacy.
    const top = FAQ.slice(0, 4).map((item) => item.question);
    expect(top).toContain('Does Hale do anything without asking?');
    expect(top).toContain('Is my family’s data private?');
    // And cost still comes after them, not before.
    const index = (q: string) => FAQ.findIndex((item) => item.question === q);
    expect(index('Is Hale free?')).toBeGreaterThan(index('Is my family’s data private?'));
  });

  it('names the municipality count the radar actually watches, not a spelled guess', () => {
    // The landing derives its count from the list; the FAQ used to spell
    // "fifteen" by hand, so a sixteenth town made the two pages disagree.
    const answers = FAQ.map((item) => item.answer).join(' ');
    expect(answers).toContain(`${MUNICIPALITY_COUNT} GTA municipalities`);
    expect(answers).not.toContain('fifteen');
  });

  it('carries the Canadian residency and teen-redaction posture (hard rule #1)', () => {
    const answers = FAQ
      .map((item) => item.answer)
      .join(' ');
    expect(answers).toContain('PIPEDA');
    expect(answers).toContain('Law 25');
    expect(answers).toContain('redacted from parents by default');
  });

  it('drives the FAQPage schema too, so an answer engine reads the served list', () => {
    const entities = faqJsonLd().mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(FAQ.length);
    expect(entities.map((q) => q.name)).toContain('What is Hale?');
  });
});
