import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV } from '~/lib/flags/landing';
import { FAQ, faqJsonLd, productFaq } from './index';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe('the FAQ served under the F14 landing', () => {
  function f14(): readonly { question: string; answer: string }[] {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    return productFaq();
  }

  it('is a different list from the dark one, and the flag is what chooses', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    expect(productFaq()).toBe(FAQ);
    expect(f14()).not.toBe(FAQ);
  });

  it('describes a number you text rather than an app you sign up for', () => {
    const answers = f14()
      .map((item) => item.answer)
      .join(' ');
    expect(answers).toContain('text');
    expect(answers).toContain('no account to create');
    // The pre-pivot list sold browsing a village of local activities; under F14 the
    // homepage offers no signup at all, so the FAQ must not re-open that door.
    expect(answers).not.toContain('sign up');
    expect(answers).not.toContain('village');
  });

  it('keeps every claim inside what ships — no named method, no outcome promise', () => {
    const all = f14()
      .map((item) => `${item.question} ${item.answer}`)
      .join(' ');
    for (const overclaim of ['Ferber', 'guaranteed', 'will fix', 'March break', 'PA day']) {
      expect(all).not.toContain(overclaim);
    }
    expect(all).toContain('never diagnoses and never names a dose');
  });

  it('carries the Canadian residency and teen-redaction posture (hard rule #1)', () => {
    const answers = f14()
      .map((item) => item.answer)
      .join(' ');
    expect(answers).toContain('PIPEDA');
    expect(answers).toContain('Law 25');
    expect(answers).toContain('redacted from parents by default');
  });

  it('drives the FAQPage schema too, so an answer engine reads the served list', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    const entities = faqJsonLd().mainEntity as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(productFaq().length);
    expect(entities.map((q) => q.name)).toContain('What is Hale?');
  });
});
