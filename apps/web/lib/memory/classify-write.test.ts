import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderMemoryBrief } from './brief';
import { acceptModelMemoryClass, modelClassificationShape } from './classify-write';

const OCT_4 = new Date('2026-10-04T15:00:00.000Z');
const OCT_1 = '2026-10-01T20:15:00.000Z';

describe('modelClassificationShape', () => {
  const shape = z.object(modelClassificationShape);

  it('refuses a save that names neither memoryClass nor disposition', () => {
    const parsed = shape.safeParse({ expiresAt: '2026-10-10T15:00:00.000Z' });

    expect(parsed.success).toBe(false);
    const missing = parsed.error?.issues.map((issue) => issue.path.join('.')).sort();
    expect(missing).toEqual(['disposition', 'memoryClass']);
  });

  it('refuses a class without a disposition', () => {
    const parsed = shape.safeParse({ memoryClass: 'enduring' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['disposition']);
  });

  it('accepts a classified save', () => {
    expect(shape.safeParse({ memoryClass: 'obligation', disposition: 'declined' })).toEqual({
      success: true,
      data: { memoryClass: 'obligation', disposition: 'declined' },
    });
  });
});

describe('acceptModelMemoryClass', () => {
  it('keeps a declined Oct 1 activity declined, on Oct 1, not a confirmed Oct 4 fact', () => {
    const accepted = acceptModelMemoryClass(
      {
        // The model may also call it identity. The decline still wins.
        memoryClass: 'enduring',
        disposition: 'declined',
        observedAt: OCT_1,
      },
      OCT_4,
    );

    expect(accepted.disposition).toBe('declined');
    expect(accepted.kind).toBe('obligation');
    expect(accepted.memoryKind).toBe('temporary');
    expect(accepted.validFrom.toISOString()).toBe(OCT_1);
    expect(accepted.validFrom.toISOString()).not.toBe(OCT_4.toISOString());
    expect(accepted.expiresAt?.toISOString()).toBe(OCT_1);
    expect(accepted.valuePatch).toMatchObject({
      disposition: 'declined',
      memoryClass: 'obligation',
    });
  });

  it('does not store a passing question as a preference, even on an identity key', () => {
    const question = acceptModelMemoryClass(
      { memoryClass: 'curiosity', disposition: 'asked' },
      OCT_4,
    );
    expect(question.memoryKind).toBe('one_off');
    expect(question.kind).toBe('curiosity');
    expect(question.disposition).toBe('asked');

    // `asked` wins over an enduring class. The key is not an input at all.
    const mislabeled = acceptModelMemoryClass(
      { memoryClass: 'enduring', disposition: 'asked' },
      OCT_4,
    );
    expect(mislabeled.memoryKind).toBe('one_off');
    expect(mislabeled.disposition).toBe('asked');

    const confirmedCuriosity = acceptModelMemoryClass(
      { memoryClass: 'curiosity', disposition: 'confirmed' },
      OCT_4,
    );
    expect(confirmedCuriosity.memoryKind).toBe('one_off');
  });

  it('stores an enduring confirmed statement as identity, and a later one can replace a question', () => {
    const question = acceptModelMemoryClass(
      { memoryClass: 'curiosity', disposition: 'asked' },
      OCT_4,
    );
    expect(question.memoryKind).toBe('one_off');

    const repeated = acceptModelMemoryClass(
      { memoryClass: 'enduring', disposition: 'confirmed' },
      OCT_4,
    );
    expect(repeated).toMatchObject({
      memoryKind: 'lasting',
      kind: 'enduring',
      disposition: 'confirmed',
      expiresAt: null,
      valuePatch: null,
    });
  });

  it('gives a confirmed one-off an expiry so it can decay', () => {
    const accepted = acceptModelMemoryClass(
      {
        memoryClass: 'obligation',
        disposition: 'confirmed',
        observedAt: '2026-10-10T15:00:00.000Z',
      },
      OCT_4,
    );
    expect(accepted.memoryKind).toBe('temporary');
    expect(accepted.expiresAt?.toISOString()).toBe('2026-10-10T15:00:00.000Z');
    // A future event is not back-dated into valid_from.
    expect(accepted.validFrom.toISOString()).toBe(OCT_4.toISOString());
  });
});

describe('memory brief kind', () => {
  const base = {
    now: OCT_4,
    timeZone: 'America/Toronto',
    teenChildIds: new Set<string>(),
    workstreams: [],
    dayDigest: null,
    weekDigest: null,
    expectedDay: '2026-10-03',
    expectedWeek: '2026-09-28',
  };

  it('drops an expired declined Oct 1 activity and does not call it confirmed', () => {
    const brief = renderMemoryBrief({
      ...base,
      facts: [
        {
          factType: 'preference',
          factKey: 'gymnastics',
          factValue: {
            text: 'Gymnastics',
            disposition: 'declined',
            memoryClass: 'obligation',
            observedAt: OCT_1,
          },
          confidence: 0.95,
          validFrom: new Date(OCT_1),
          childId: null,
          memoryKind: 'temporary',
          memorySource: 'inferred',
          expiresAt: new Date(OCT_1),
        },
      ],
    });
    expect(brief.text).not.toContain('gymnastics');
    expect(brief.text).not.toContain('Gymnastics');
    expect(brief.text).not.toContain('disposition=confirmed');
  });

  it('labels a passing question as curiosity and a future decline as declined', () => {
    const brief = renderMemoryBrief({
      ...base,
      facts: [
        {
          factType: 'preference',
          factKey: 'saturday_swim',
          factValue: {
            summary: 'what about swimming this Saturday?',
            disposition: 'asked',
            memoryClass: 'curiosity',
          },
          confidence: 0.8,
          validFrom: OCT_4,
          childId: null,
          memoryKind: 'one_off',
          memorySource: 'inferred',
        },
        {
          factType: 'logistic',
          factKey: 'gymnastics',
          factValue: {
            summary: 'Gymnastics',
            disposition: 'declined',
            memoryClass: 'obligation',
            observedAt: '2026-10-10T20:15:00.000Z',
          },
          confidence: 0.95,
          validFrom: OCT_4,
          childId: null,
          memoryKind: 'temporary',
          memorySource: 'inferred',
          expiresAt: new Date('2026-10-10T20:15:00.000Z'),
        },
      ],
    });
    expect(brief.text).toContain('passing:');
    expect(brief.text).toContain('kind=curiosity');
    expect(brief.text).toContain('disposition=asked');
    expect(brief.text).not.toContain('preferences:');
    expect(brief.text).toContain('obligations:');
    expect(brief.text).toContain('kind=obligation');
    expect(brief.text).toContain('disposition=declined');
    expect(brief.text).toContain('observed=2026-10-10');
    expect(brief.text).not.toContain('disposition=confirmed');
  });
});
