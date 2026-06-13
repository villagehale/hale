import { describe, expect, it } from 'vitest';
import { toCoachAnswerView } from './view';

describe('toCoachAnswerView — framework citations → the UI string[] shape', () => {
  it('labels the framework and appends reference + excerpt when present', () => {
    const view = toCoachAnswerView({
      adviceText: 'short naps at four months are common.',
      frameworkCitations: [
        { framework: 'karp', reference: 'The Happiest Baby, ch. 5', excerpt: '4-month sleep regression' },
        { framework: 'health_canada', reference: 'Caring for Kids — sleep' },
      ],
      confidence: 0.9,
      followUpQuestions: [],
      flagForPediatrician: false,
    });

    expect(view.citations).toEqual([
      'karp · The Happiest Baby — The Happiest Baby, ch. 5 — 4-month sleep regression',
      'health canada · Caring for Kids — Caring for Kids — sleep',
    ]);
    expect(view.body).toBe('short naps at four months are common.');
  });

  it('carries an empty citations list straight through', () => {
    const view = toCoachAnswerView({
      adviceText: 'i need a bit more to answer that.',
      frameworkCitations: [],
      confidence: 0.4,
      followUpQuestions: ['how old is your child?'],
      flagForPediatrician: false,
    });

    expect(view.citations).toEqual([]);
    expect(view.followUps).toEqual(['how old is your child?']);
  });
});
