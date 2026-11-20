import { describe, expect, it } from 'vitest';
import {
  CAREGIVER_REMINDER_FIXTURES,
  CONSENT_KEYWORDLESS_FIXTURES,
  JOIN_DOOR_FIXTURES,
} from './join-door-fixtures.mjs';

const ALL = [
  ...JOIN_DOOR_FIXTURES,
  ...CAREGIVER_REMINDER_FIXTURES,
  ...CONSENT_KEYWORDLESS_FIXTURES,
];

describe('join door eval fixtures', () => {
  it('covers the welcome, the inviter ack, and the caregiver yes and no', () => {
    const ids = JOIN_DOOR_FIXTURES.map((fixture) => fixture.id);
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
    }
  });

  it('gives every case a unique id and a STOP check for the human reading the recording', () => {
    const ids = ALL.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of ALL) expect(fixture.watchFor).toContain('STOP');
  });

  it('covers the caregiver reminder at both offsets, in French, all day, and against a hostile title', () => {
    const inputs = CAREGIVER_REMINDER_FIXTURES.map((fixture) => fixture.input);
    expect(new Set(inputs.map((input) => input.offset))).toEqual(new Set(['-P1D', '-PT1H']));
    expect(inputs.some((input) => input.language === 'fr')).toBe(true);
    expect(inputs.some((input) => input.events.length > 1)).toBe(true);
    expect(inputs.some((input) => input.events.some((e) => e.title.includes('STOP')))).toBe(true);
  });

  it('covers each of the four stranger kinds the lit consent ask writes without a keyword', () => {
    expect(new Set(CONSENT_KEYWORDLESS_FIXTURES.map((fixture) => fixture.ask.kind))).toEqual(
      new Set(['caregiver_invite', 'caregiver_nudge', 'coparent_invite', 'coparent_nudge']),
    );
  });
});
