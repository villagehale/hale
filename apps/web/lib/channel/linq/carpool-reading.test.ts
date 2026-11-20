import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCarpoolPickup } from './carpool-apply';
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

  it('never takes a pickup instant from the model, only its local day and clock', () => {
    // Friday's EDT offset pinned on Sunday 08:00: the reading that stored Sunday 07:00.
    const offsetOnly = parseCarpoolReading({
      intent: 'driver_claim',
      driverName: 'Maya',
      eventLabel: 'soccer',
      pickupAtIso: '2026-11-01T08:00:00-04:00',
      pickupPlace: null,
      kids: null,
      confidence: 'high',
    });
    expect(offsetOnly.pickupAtIso).toBeNull();
    expect(resolveCarpoolPickup(offsetOnly, 'America/Toronto')).toBeNull();

    const withDay = parseCarpoolReading({
      intent: 'driver_claim',
      driverName: 'Maya',
      eventLabel: 'soccer',
      pickupDate: '2026-10-31',
      pickupTime: '08:00',
      pickupAtIso: '2026-11-01T08:00:00-04:00',
      pickupPlace: null,
      kids: null,
      confidence: 'high',
    });
    expect(resolveCarpoolPickup(withDay, 'America/Toronto')?.toISOString()).toBe(
      '2026-10-31T12:00:00.000Z',
    );
  });

  it('leaves a day that is not on the calendar empty instead of rolling it into March', () => {
    const reading = parseCarpoolReading({
      intent: 'plan_needs_driver',
      driverName: null,
      eventLabel: 'soccer',
      pickupDate: '2026-02-30',
      pickupTime: '08:00',
      pickupPlace: null,
      kids: null,
      confidence: 'high',
    });
    expect(reading.pickupDate).toBeNull();
    const at = (pickupDate: string) =>
      resolveCarpoolPickup(
        { pickupDate, pickupTime: '08:00', pickupAtIso: null },
        'America/Toronto',
      );
    expect(at('2026-02-30')).toBeNull();
    // 2028 is a leap year; Toronto is on EST (UTC−5) in February.
    expect(at('2028-02-29')?.toISOString()).toBe('2028-02-29T13:00:00.000Z');
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
