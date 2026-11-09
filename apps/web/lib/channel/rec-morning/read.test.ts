import { describe, expect, it } from 'vitest';
import { recMorningReply } from './copy';
import type { RecMorningWhere } from './match';
import { REC_MORNING_READ_TOOL_SCHEMA, acceptRecMorningReading } from './read';

describe('the rec-morning-read eval reads only turns the word test passes', () => {
  it('every fixture reaches the reader in production, on both paths', async () => {
    const path = '../../../../worker/evals/rec-morning-read-fixtures.mjs';
    const {
      REC_MORNING_READ_FIXTURES: fixtures,
      REC_MORNING_READ_NOW: now,
      REC_MORNING_READ_WHERE: where,
    } = (await import(/* @vite-ignore */ path)) as {
      REC_MORNING_READ_FIXTURES: Array<{ id: string; path: string; text: string; expect: string }>;
      REC_MORNING_READ_NOW: string;
      REC_MORNING_READ_WHERE: RecMorningWhere;
    };
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    for (const fixture of fixtures) {
      expect(recMorningReply(fixture.text, new Date(now), where), fixture.id).not.toBeNull();
    }
    expect(new Set(fixtures.map((fixture) => fixture.expect))).toEqual(
      new Set(['answers', 'other']),
    );
    expect(new Set(fixtures.map((fixture) => fixture.path))).toEqual(new Set(['group', 'direct']));
  });
});

/**
 * The structural half of the read. What a text MEANS is the model's, pinned by the
 * rec-morning-read eval; this pins only that code keeps nothing but the two readings,
 * and that the reason is asked for before the verdict.
 */
describe('acceptRecMorningReading', () => {
  it.each(['answers', 'other'] as const)('keeps %s', (reading) => {
    expect(acceptRecMorningReading({ reason: 'r', reading })).toBe(reading);
  });

  it('drops a reading outside the two', () => {
    expect(acceptRecMorningReading({ reason: 'r', reading: 'registration' })).toBeNull();
  });

  it('asks for the reason before the reading', () => {
    expect(Object.keys(REC_MORNING_READ_TOOL_SCHEMA.properties)).toEqual(['reason', 'reading']);
    expect(REC_MORNING_READ_TOOL_SCHEMA.required).toEqual(['reason', 'reading']);
  });
});
