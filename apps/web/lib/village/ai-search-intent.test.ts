import { describe, expect, it } from 'vitest';
import {
  formatInterpretation,
  isEmptyIntent,
  keywordFallbackIntent,
  parseIntentAnswer,
  type VillageSearchIntent,
} from './ai-search-intent';

const base: VillageSearchIntent = {
  categories: [],
  keywords: [],
  season: null,
  childAgeMonths: null,
  familyScoped: false,
};

describe('parseIntentAnswer', () => {
  it('parses a clean JSON object into a validated intent', () => {
    const answer = JSON.stringify({
      categories: ['childcare'],
      keywords: ['Montessori'],
      season: 'fall',
      childAgeMonths: 40,
      familyScoped: false,
    });
    expect(parseIntentAnswer(answer)).toEqual({
      categories: ['childcare'],
      keywords: ['montessori'],
      season: 'fall',
      childAgeMonths: 40,
      familyScoped: false,
    });
  });

  it('extracts the JSON object when the model wraps it in prose', () => {
    const answer = 'Sure — here is the intent:\n```json\n{"keywords":["swim"],"season":"winter"}\n```\nHope that helps.';
    const intent = parseIntentAnswer(answer);
    expect(intent?.keywords).toEqual(['swim']);
    expect(intent?.season).toBe('winter');
  });

  it('drops an out-of-vocabulary category and season rather than failing the whole parse', () => {
    const answer = JSON.stringify({
      categories: ['childcare', 'tutoring'],
      keywords: ['french', 'immersion'],
      season: 'monsoon',
    });
    const intent = parseIntentAnswer(answer);
    expect(intent?.categories).toEqual(['childcare']);
    expect(intent?.season).toBeNull();
    expect(intent?.keywords).toEqual(['french', 'immersion']);
  });

  it('nulls a teen-range age to family-scoped so a teen age can never reach the echo (rule #1)', () => {
    const answer = JSON.stringify({ keywords: ['coding'], childAgeMonths: 180 });
    const intent = parseIntentAnswer(answer);
    expect(intent?.childAgeMonths).toBeNull();
    expect(intent?.familyScoped).toBe(true);
  });

  it('returns null when the answer carries no JSON object (caller falls back)', () => {
    expect(parseIntentAnswer('I could not understand that request.')).toBeNull();
    expect(parseIntentAnswer(null)).toBeNull();
    expect(parseIntentAnswer('{ not valid json ]')).toBeNull();
  });

  it('de-dupes and bounds keywords, coercing a float age to an int', () => {
    const answer = JSON.stringify({
      keywords: ['Swim', 'swim', 'SWIM ', 'lessons'],
      childAgeMonths: 36.7,
    });
    const intent = parseIntentAnswer(answer);
    expect(intent?.keywords).toEqual(['swim', 'lessons']);
    expect(intent?.childAgeMonths).toBe(37);
  });
});

describe('keywordFallbackIntent', () => {
  it('extracts meaningful keywords and drops stopwords', () => {
    const intent = keywordFallbackIntent('I want to find a good swim class for my kid');
    expect(intent.keywords).toContain('swim');
    expect(intent.keywords).toContain('class');
    expect(intent.keywords).not.toContain('good');
    expect(intent.keywords).not.toContain('for');
  });

  it('detects the season word (fall/autumn/winter) and removes it from keywords', () => {
    expect(keywordFallbackIntent('montessori in the fall').season).toBe('fall');
    expect(keywordFallbackIntent('leaf raking this autumn').season).toBe('fall');
    expect(keywordFallbackIntent('skating this winter').season).toBe('winter');
    expect(keywordFallbackIntent('montessori in the fall').keywords).not.toContain('fall');
  });

  it('never fabricates a category or age — it only knows keywords and season', () => {
    const intent = keywordFallbackIntent('swim for my 3yo this winter');
    expect(intent.categories).toEqual([]);
    expect(intent.childAgeMonths).toBeNull();
    expect(intent.familyScoped).toBe(false);
  });

  it('yields an empty intent for pure chatter / stopwords', () => {
    expect(isEmptyIntent(keywordFallbackIntent('can you find me something'))).toBe(true);
  });
});

describe('formatInterpretation', () => {
  it('echoes the founder example in reading order', () => {
    const intent: VillageSearchIntent = {
      categories: ['childcare'],
      keywords: ['montessori'],
      season: 'fall',
      childAgeMonths: 40,
      familyScoped: false,
    };
    expect(formatInterpretation(intent)).toBe('montessori · childcare · starting fall · for a 3-year-old');
  });

  it('reads "for your family" for a family-scoped ask and never a teen age (rule #1)', () => {
    expect(formatInterpretation({ ...base, keywords: ['coding'], familyScoped: true })).toBe(
      'coding · for your family',
    );
  });

  it('reads "near you" for an empty intent', () => {
    expect(formatInterpretation(base)).toBe('near you');
  });

  it('renders an infant age in months, not a rounded 0 years', () => {
    expect(formatInterpretation({ ...base, childAgeMonths: 8 })).toBe('for a 8-month-old');
  });
});
