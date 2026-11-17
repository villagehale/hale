import { describe, expect, it } from 'vitest';
import { JOIN_DOOR_FIXTURES } from './join-door-fixtures.mjs';

describe('join door eval fixtures', () => {
  it('covers the welcome, the inviter ack, and the caregiver yes and no', () => {
    const ids = JOIN_DOOR_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'join-welcome',
        'join-accepted-ack',
        'caregiver-welcome',
        'caregiver-decline',
      ]),
    );
    for (const fixture of JOIN_DOOR_FIXTURES) {
      expect(fixture.request.purpose).toEqual(expect.any(String));
      expect(fixture.watchFor.toLowerCase()).toContain('no stop');
    }
  });
});
