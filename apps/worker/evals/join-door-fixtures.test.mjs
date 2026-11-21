import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CAREGIVER_REMINDER_FIXTURES,
  CONSENT_KEYWORDLESS_FIXTURES,
  JOIN_DOOR_FIXTURES,
  doorLineMisses,
} from './join-door-fixtures.mjs';

const WEB_LIB = new URL('../../web/lib/', import.meta.url);
const WEB_TSCONFIG = new URL('../../web/tsconfig.json', import.meta.url).pathname;
const DOOR_SKILL = new URL('../../../packages/agent/skills/door-line.md', import.meta.url);

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

  it('promises a caregiver only the reminders they actually get', () => {
    const skill = readFileSync(DOOR_SKILL, 'utf8');
    const welcome = skill.split('\n').find((line) => line.includes('`caregiver_welcome`'));
    expect(welcome).toContain('evening before');
    expect(welcome).toContain('hour before');
    expect(welcome).not.toMatch(/schedule/i);
    const scoped = skill.split('\n').find((line) => line.includes('`caregiver_scoped_reply`'));
    expect(scoped).toContain('reminders');
    expect(scoped).not.toMatch(/schedule/i);
    for (const fixture of JOIN_DOOR_FIXTURES.filter((f) => f.id.startsWith('caregiver-welcome'))) {
      expect(fixture.watchFor).not.toMatch(/schedule/i);
    }
  });
});

describe('scoring a caregiver reminder whose place holds a keyword, with no model', () => {
  let spoken;
  let caregiver;
  let voice;

  beforeAll(async () => {
    const options = { parentURL: import.meta.url, tsconfig: WEB_TSCONFIG };
    spoken = await tsImport(new URL('channel/spoken-line.ts', WEB_LIB).href, options);
    caregiver = await tsImport(
      new URL('loop/templates/caregiver/compose.ts', WEB_LIB).href,
      options,
    );
    voice = await tsImport(new URL('channel/intake/friend-voice.ts', WEB_LIB).href, options);
  }, 180_000);

  function keywordPlaceRequest() {
    const fixture = CAREGIVER_REMINDER_FIXTURES.find(
      (f) => f.id === 'caregiver-reminder-keyword-place',
    );
    return caregiver.caregiverReminderRequest({
      ...fixture.input,
      now: new Date(fixture.input.now),
      events: fixture.input.events.map((e) => ({
        ...e,
        startsAt: new Date(e.startsAt),
        endsAt: e.endsAt ? new Date(e.endsAt) : null,
      })),
    });
  }

  const FAITHFUL = 'Pickup is today at 4:15 PM, about an hour from now, at BUS STOP 14, King St.';

  it('a faithful line is accepted and scores clean', () => {
    const request = keywordPlaceRequest();
    expect(spoken.acceptSpokenRequest(FAITHFUL, request)).toBe(FAITHFUL);
    expect(doorLineMisses(FAITHFUL, voice, spoken.keywordFactPieces(request))).toEqual([]);
  });

  it('positive control: the same line scored whole trips the judge on the place', () => {
    expect(doorLineMisses(FAITHFUL, voice)).toEqual(['friend_voice:compliance']);
  });

  it('a keyword the draft adds around the place is still a miss', () => {
    const request = keywordPlaceRequest();
    const taught = `${FAITHFUL} Reply STOP to leave.`;
    expect(doorLineMisses(taught, voice, spoken.keywordFactPieces(request))).toEqual([
      'friend_voice:compliance',
    ]);
  });
});
