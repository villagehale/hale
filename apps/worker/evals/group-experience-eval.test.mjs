import { describe, expect, it } from 'vitest';
import {
  GROUP_EXPERIENCE_READ_FIXTURES,
  GROUP_EXPERIENCE_SCENE_FIXTURES,
  GROUP_EXPERIENCE_VOICE_FIXTURES,
} from './group-experience-fixtures.mjs';

describe('VIL-399 group experience fixtures', () => {
  it('covers the ten Barton scenes and is not a paid CI run', () => {
    expect(GROUP_EXPERIENCE_SCENE_FIXTURES.map((fixture) => fixture.scene)).toEqual([
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
    ]);
    expect(GROUP_EXPERIENCE_READ_FIXTURES.length).toBeGreaterThan(0);
    expect(GROUP_EXPERIENCE_VOICE_FIXTURES.length).toBeGreaterThan(0);
  });
});
