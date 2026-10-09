import { describe, expect, it } from 'vitest';
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
      expect(Object.keys(q).sort()).toEqual(['@type', 'acceptedAnswer', 'name']);
    }
  });

  it('keeps the anchor slug out of FAQPage JSON-LD', () => {
    const serialized = JSON.stringify(faqJsonLd());
    for (const item of FAQ) {
      expect(serialized).not.toContain(item.id);
    }
  });

  it('gives every question a unique English slug', () => {
    expect(FAQ.map((item) => item.id)).toEqual([
      'what-is-hale',
      'how-do-i-start',
      'do-i-need-an-app-or-an-account',
      'can-hale-join-our-group-chat',
      'what-does-hale-do-in-a-group',
      'what-do-other-parents-in-the-group-see',
      'is-my-co-parent-free',
      'does-hale-book-or-register-for-me',
      'what-does-hale-find',
      'can-i-ask-it-other-things',
      'how-often-will-hale-text-me',
      'will-hale-tell-me-if-a-class-is-any-good',
      'is-it-free',
      'what-happens-to-our-data',
      'is-hale-a-person',
      'is-hale-official',
    ]);
    expect(new Set(FAQ.map((item) => item.id)).size).toBe(FAQ.length);
  });
});

describe('the FAQ this build serves', () => {
  it('is the cleared question list, in order', () => {
    expect(FAQ.map((item) => item.question)).toEqual([
      'What is Hale?',
      'How do I start?',
      'Do I need an app or an account?',
      'Can Hale join our group chat?',
      'What does Hale do in a group?',
      'What do other parents in the group see?',
      'Is my co-parent free?',
      'Does Hale book or register for me?',
      'What does Hale find?',
      'Can I ask it other things?',
      'How often will Hale text me?',
      'Will Hale tell me if a class is any good?',
      'Is it free?',
      'What happens to our data?',
      'Is Hale a person?',
      'Is Hale official?',
    ]);
  });

  it('drops place names and the outside-Canada question', () => {
    const blob = FAQ.map((item) => `${item.question} ${item.answer}`).join('\n');
    expect(blob).not.toMatch(/Georgetown|GTA|EarlyON|Stouffville|outside Canada|stored in Canada/i);
    expect(blob).toContain('Village Hale Technologies Inc., a small parent-founded company');
    expect(blob).toContain('Is Hale official?');
  });

  it('says signing up for you is later, and only with a yes', () => {
    const book = FAQ.find((item) => item.question === 'Does Hale book or register for me?');
    expect(book?.answer.startsWith('Not yet.')).toBe(true);
    expect(book?.answer).toContain('only when you say yes');
  });
});
