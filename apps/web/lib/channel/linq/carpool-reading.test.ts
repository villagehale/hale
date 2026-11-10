import { afterEach, describe, expect, it, vi } from 'vitest';
import { carpoolUserMessage, parseCarpoolReading, readingFromTapback } from './carpool-reading';
import { linqGroupCarpoolEnabled } from './config';

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
        nowIso: '2026-10-08T16:00:00.000Z',
        timeZone: 'America/Toronto',
        recent: [{ from: 'member', text: "on a besoin d'un chauffeur" }],
      }),
    );
    expect(payload.text).toBe("je m'en occupe samedi");
    expect(payload).not.toHaveProperty('keywords');
  });
});
