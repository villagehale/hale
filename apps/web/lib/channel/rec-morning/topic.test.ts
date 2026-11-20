import { describe, expect, it } from 'vitest';
import { recMorningCatalog } from './copy';
import type { RecMorningWhere } from './match';
import { REC_MORNING_TOPIC_TOOL_SCHEMA, acceptRecMorningTopic } from './topic';

const TORONTO: RecMorningWhere = {
  municipality: 'toronto',
  postal: null,
  timeZone: 'America/Toronto',
};

describe('the rec-morning-topic eval reads the family catalog, not the word test', () => {
  it('every fixture is a turn the picker sees in production, on both paths', async () => {
    const path = '../../../../worker/evals/rec-morning-topic-fixtures.mjs';
    const {
      REC_MORNING_TOPIC_FIXTURES: fixtures,
      REC_MORNING_TOPIC_NOW: now,
      REC_MORNING_TOPIC_WHERE: where,
    } = (await import(/* @vite-ignore */ path)) as {
      REC_MORNING_TOPIC_FIXTURES: Array<{
        id: string;
        path: string;
        text: string;
        expect: string;
      }>;
      REC_MORNING_TOPIC_NOW: string;
      REC_MORNING_TOPIC_WHERE: RecMorningWhere;
    };
    expect(fixtures.length).toBeGreaterThanOrEqual(11);
    const catalog = recMorningCatalog(new Date(now), where);
    expect(catalog.length).toBeGreaterThan(0);
    const known = new Set(['none', ...catalog.map((entry) => entry.topic)]);
    for (const fixture of fixtures) {
      expect(known.has(fixture.expect), fixture.id).toBe(true);
    }
    expect(new Set(fixtures.map((fixture) => fixture.path))).toEqual(new Set(['group', 'direct']));
    expect(fixtures.some((fixture) => fixture.expect === 'none')).toBe(true);
    expect(fixtures.some((fixture) => fixture.expect !== 'none')).toBe(true);
  });
});

describe('acceptRecMorningTopic', () => {
  const known = ['toronto_swim', 'toronto_rec'] as const;

  it('keeps none', () => {
    expect(acceptRecMorningTopic({ reason: 'r', topic: 'none' }, known)).toBe('none');
  });

  it('keeps a catalog id', () => {
    expect(acceptRecMorningTopic({ reason: 'r', topic: 'toronto_swim' }, known)).toBe(
      'toronto_swim',
    );
  });

  it('drops a topic outside the catalog', () => {
    expect(acceptRecMorningTopic({ reason: 'r', topic: 'markham' }, known)).toBeNull();
  });

  it('asks for the reason before the topic', () => {
    expect(Object.keys(REC_MORNING_TOPIC_TOOL_SCHEMA.properties)).toEqual(['reason', 'topic']);
    expect(REC_MORNING_TOPIC_TOOL_SCHEMA.required).toEqual(['reason', 'topic']);
  });
});

describe('recMorningCatalog', () => {
  const afterYmca = new Date('2026-11-08T14:00:00.000Z');

  it('hands a Toronto family its portal topics plus GTA-wide facts, not a word test', () => {
    const ids = recMorningCatalog(afterYmca, TORONTO).map((entry) => entry.topic);
    expect(ids).toEqual(
      expect.arrayContaining([
        'toronto_swim',
        'toronto_rec',
        'toronto_waitlist',
        'toronto_wishlist',
        'toronto_efun',
        'two_parents',
        'ymca_follow',
        'jack_of_sports',
      ]),
    );
    expect(ids).not.toContain('markham');
    expect(ids).not.toContain('ymca_gta_swim');
  });

  it('does not put Toronto portal facts on a Markham family', () => {
    const ids = recMorningCatalog(afterYmca, {
      municipality: 'markham',
      postal: null,
      timeZone: 'America/Toronto',
    }).map((entry) => entry.topic);
    expect(ids).not.toContain('toronto_swim');
    expect(ids).not.toContain('toronto_efun');
    expect(ids).toContain('ymca_follow');
    expect(ids).toContain('jack_of_sports');
  });
});
