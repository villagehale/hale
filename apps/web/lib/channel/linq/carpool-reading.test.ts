import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARPOOL_READING_TOOL_SCHEMA,
  carpoolUserMessage,
  parseCarpoolReading,
  readingFromTapback,
} from './carpool-reading';
import { linqGroupCarpoolEnabled } from './config';

const READING_SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/agent/skills/carpool-reading.md',
);

/** Friday 9:00pm America/Toronto — already Saturday 01:00 UTC while EDT (UTC−4) is in force. */
const FRIDAY_NIGHT_ET = new Date('2026-10-31T01:00:00.000Z');

describe('linqGroupCarpoolEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays dark unless the flag is exactly true', () => {
    expect(linqGroupCarpoolEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'on');
    expect(linqGroupCarpoolEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_CARPOOL_ENABLED', 'true');
    expect(linqGroupCarpoolEnabled()).toBe(true);
  });
});

describe('parseCarpoolReading', () => {
  it('accepts a model object and treats empty strings as missing facts', () => {
    expect(
      parseCarpoolReading({
        intent: 'driver_claim',
        driverName: 'Maya',
        eventLabel: 'soccer',
        pickupAtIso: '',
        pickupPlace: '  ',
        kids: 'Noah',
        confidence: 'high',
      }),
    ).toEqual({
      intent: 'driver_claim',
      driverName: 'Maya',
      driverIsSender: false,
      eventLabel: 'soccer',
      pickupDate: null,
      pickupTime: null,
      pickupAtIso: null,
      pickupPlace: null,
      kids: 'Noah',
      confidence: 'high',
    });
  });

  it('does not accept a shape the skill did not return', () => {
    expect(parseCarpoolReading({ intent: 'drive', driver: 'Maya' })).toMatchObject({
      intent: 'unclear',
      confidence: 'low',
    });
  });
});

describe('readingFromTapback', () => {
  it("reads a heart on Hale's ask as that person taking the drive", () => {
    expect(readingFromTapback({ reactionType: 'love', reactorName: 'Priya', onAsk: true })).toEqual(
      {
        intent: 'driver_claim',
        driverName: 'Priya',
        driverIsSender: true,
        eventLabel: null,
        pickupDate: null,
        pickupTime: null,
        pickupAtIso: null,
        pickupPlace: null,
        kids: null,
        confidence: 'high',
      },
    );
  });

  it('ignores a tapback that is not on the ask', () => {
    expect(
      readingFromTapback({ reactionType: 'like', reactorName: 'Maya', onAsk: false }),
    ).toBeNull();
  });
});

describe('carpoolUserMessage', () => {
  it('hands the model the thread, not a keyword list', () => {
    const payload = JSON.parse(
      carpoolUserMessage({
        text: "je m'en occupe samedi",
        senderName: 'Camille',
        memberNames: ['Camille', 'Noah'],
        currentDriver: null,
        now: new Date('2026-10-08T16:00:00.000Z'),
        timeZone: 'America/Toronto',
        recent: [{ from: 'member', text: "on a besoin d'un chauffeur" }],
      }),
    );
    expect(payload.text).toBe("je m'en occupe samedi");
    expect(payload).not.toHaveProperty('keywords');
  });

  it('anchors “tomorrow Saturday” on the Toronto day after 8pm, not the UTC date', () => {
    for (const text of ['tomorrow Saturday 8am', '明天周六 8am']) {
      const payload = JSON.parse(
        carpoolUserMessage({
          text,
          senderName: 'Maya',
          memberNames: ['Maya'],
          currentDriver: null,
          now: FRIDAY_NIGHT_ET,
          timeZone: 'America/Toronto',
          recent: [],
        }),
      );
      expect(payload.now).toMatchObject({
        date: '2026-10-30',
        weekday: 'Friday',
        time: '21:00',
      });
      expect(payload.now.nextDays[1]).toEqual({ date: '2026-10-31', weekday: 'Saturday' });
      expect(payload).not.toHaveProperty('nowIso');
    }
  });
});

describe('carpool reading contract', () => {
  it('asks for a local date and wall clock, not an instant the model converts', () => {
    expect(CARPOOL_READING_TOOL_SCHEMA.properties).toHaveProperty('pickupDate');
    expect(CARPOOL_READING_TOOL_SCHEMA.properties).toHaveProperty('pickupTime');
    expect(CARPOOL_READING_TOOL_SCHEMA.properties).not.toHaveProperty('pickupAtIso');
    expect(CARPOOL_READING_TOOL_SCHEMA.required).toEqual(
      expect.arrayContaining(['pickupDate', 'pickupTime']),
    );
  });

  it('tells the reader to copy the day from the local calendar', () => {
    const skill = readFileSync(READING_SKILL, 'utf8');
    expect(skill).toContain('nextDays');
    expect(skill).not.toContain('nowIso');
  });
});
