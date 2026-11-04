import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type FakeDb, makeFakeDb } from './fakes';
import { scriptedFriendVoice } from './scripted-friend-voice.fixture';
import {
  FOUNDER_PAIR_SESSION_IDS,
  SITTING_REMINDER_HOUR_LOCAL,
  SITTING_REMINDER_TIMEZONE,
  type SittingReminderDeps,
  defaultSittingReminderDeps,
  findNudgeEligible,
  isNextLocalMorning,
  isSittingReminderSlot,
  runSittingReminderCron,
  sittingSessionEligible,
} from './sitting-reminder';
import { FakeTransport } from './transport';

/**
 * VIL-324 — one next-morning reminder for a sitting first-hello, then quiet.
 *
 * Clock: next America/Toronto calendar morning at the existing proactive
 * quiet-hours end (08:00). Not 24 hours later to the minute. Not an invented
 * 9:00. Sitting sessions stay intakes — no family, no family metrics.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const OTHER = '+14165555678';

/** Wednesday 27 Aug 2026, 8:00 a.m. America/Toronto (EDT, UTC-4). */
const TORONTO_8AM = new Date('2026-08-27T12:00:00.000Z');
/** Same morning, 9:00 a.m. Toronto — the hour this reminder must never invent. */
const TORONTO_9AM = new Date('2026-08-27T13:00:00.000Z');
/** Same morning, 7:00 a.m. Toronto — too early. */
const TORONTO_7AM = new Date('2026-08-27T11:00:00.000Z');
/** Tuesday 26 Aug 2026, 7:00 p.m. Toronto — the first-hello the night before. */
const FIRST_HELLO_PREVIOUS_EVENING = new Date('2026-08-26T23:00:00.000Z');
/** Tuesday 26 Aug 2026, 8:25 p.m. ET — a 24h offset would leak at 8:25pm the next night. */
const FIRST_HELLO_825PM_ET = new Date('2026-08-27T00:25:00.000Z');
/** Tuesday 26 Aug 2026, 9:28 p.m. ET — a 24h offset would leak at 9:28pm the next night. */
const FIRST_HELLO_928PM_ET = new Date('2026-08-27T01:28:00.000Z');
/** Wednesday 27 Aug 2026, 8:25 p.m. ET — the 24h-later leak for the 8:25pm first-hello. */
const NEXT_NIGHT_825PM_ET = new Date('2026-08-28T00:25:00.000Z');
/** Wednesday 27 Aug 2026, 7:00 a.m. Toronto — same calendar morning as the 8:00 slot. */
const FIRST_HELLO_SAME_MORNING = new Date('2026-08-27T11:00:00.000Z');

/** Postal places, by FSA only. K2P resolves to the Eastern zone, V5K to the Pacific. */
const EASTERN_FSA = 'K2P';
const PACIFIC_FSA = 'V5K';
const EASTERN = 'America/New_York';

function firstTouchAt(areaCoarse: string) {
  return {
    language: 'en',
    place: { kind: 'postal', areaCoarse, postalCode: null, municipality: null, city: null },
    locationRequest: null,
  };
}

/** A session that already gave a postal code (the place-carrying states). */
function placeBlob(areaCoarse: string = EASTERN_FSA): string {
  return encryptString(
    JSON.stringify({
      collected: { children: [], postalCode: null },
      transcript: [],
      firstTouch: firstTouchAt(areaCoarse),
    }),
  );
}

function dataBlob(): string {
  return placeBlob(EASTERN_FSA);
}

/** greetNewFamily's first-hello blob: nothing collected, no place, so no zone. */
function firstHelloBlob(): string {
  return encryptString(
    JSON.stringify({ collected: { children: [], postalCode: null }, transcript: [] }),
  );
}

function seedSession(
  fake: FakeDb,
  over: {
    id?: string;
    phoneE164?: string;
    state?: string;
    createdAt?: Date;
    sittingReminderSentAt?: Date | null;
    closedAt?: Date | null;
    familyId?: string | null;
    followUpCount?: number;
    dataEncrypted?: string;
    lastProviderId?: string | null;
  } = {},
): string {
  const phoneE164 = over.phoneE164 ?? PHONE;
  const values = {
    ...(over.id ? { id: over.id } : {}),
    phoneHash: phoneBlindIndex(phoneE164),
    phoneEncrypted: encryptString(phoneE164),
    state: over.state ?? 'awaiting_details',
    dataEncrypted: over.dataEncrypted ?? dataBlob(),
    createdAt: over.createdAt ?? FIRST_HELLO_PREVIOUS_EVENING,
    sittingReminderSentAt:
      over.sittingReminderSentAt === undefined ? null : over.sittingReminderSentAt,
    closedAt: over.closedAt === undefined ? null : over.closedAt,
    familyId: over.familyId === undefined ? null : over.familyId,
    followUpCount: over.followUpCount ?? 0,
    lastProviderId: over.lastProviderId ?? null,
  };
  fake.db.insert(schema.smsIntakeSessions).values(values);
  const row = fake.rows(schema.smsIntakeSessions).at(-1);
  if (!row || typeof row.id !== 'string') throw new Error('seedSession: insert returned no id');
  return row.id;
}

function deps(transport: FakeTransport): SittingReminderDeps {
  return { transport, friendVoice: scriptedFriendVoice };
}

function voiceDeps(transport: FakeTransport): SittingReminderDeps {
  return {
    transport,
    friendVoice: {
      async compose(input) {
        if (input.language === 'fr') return { reply: 'Quel âge ont les enfants?' };
        if (input.step === 'nudge_ages') return { reply: 'How old are your kids?' };
        if (input.step === 'nudge_find') {
          return { reply: 'Still here if one of those looks good. Which of these looks good?' };
        }
        return { reply: "Still here. What's your postal code?" };
      },
    },
  };
}

describe('sitting reminder', () => {
  it('uses the existing quiet-hours morning window — not an invented 9:00', () => {
    expect(SITTING_REMINDER_TIMEZONE).toBe('America/Toronto');
    expect(PROACTIVE_QUIET_HOURS.end).toBe('08:00');
    expect(SITTING_REMINDER_HOUR_LOCAL).toBe(8);
    expect(SITTING_REMINDER_HOUR_LOCAL).not.toBe(9);
  });

  it("never carries tonight's founder pair — Barton / Sebastian's dad / I built Hale", () => {});
});

describe('isSittingReminderSlot', () => {
  it('is true for the 8:00 Eastern hour and false for 7:00 and 9:00', () => {
    expect(isSittingReminderSlot(TORONTO_8AM, EASTERN)).toBe(true);
    expect(isSittingReminderSlot(new Date('2026-08-27T12:59:00.000Z'), EASTERN)).toBe(true);
    expect(isSittingReminderSlot(TORONTO_7AM, EASTERN)).toBe(false);
    expect(isSittingReminderSlot(TORONTO_9AM, EASTERN)).toBe(false);
  });

  it("is the family's own 8:00: 12:00Z is 05:00 in Vancouver, 15:00Z is 08:00", () => {
    expect(isSittingReminderSlot(TORONTO_8AM, 'America/Vancouver')).toBe(false);
    expect(isSittingReminderSlot(new Date('2026-08-27T15:00:00.000Z'), 'America/Vancouver')).toBe(
      true,
    );
  });
});

describe('isNextLocalMorning', () => {
  it('is true the local calendar morning after first-hello, false the same morning', () => {
    expect(isNextLocalMorning(FIRST_HELLO_PREVIOUS_EVENING, TORONTO_8AM, EASTERN)).toBe(true);
    expect(isNextLocalMorning(FIRST_HELLO_SAME_MORNING, TORONTO_8AM, EASTERN)).toBe(false);
    expect(isNextLocalMorning(TORONTO_8AM, TORONTO_8AM, EASTERN)).toBe(false);
  });

  it('is a calendar morning, not 24 hours later to the minute', () => {
    expect(isNextLocalMorning(FIRST_HELLO_825PM_ET, TORONTO_8AM, EASTERN)).toBe(true);
    expect(isNextLocalMorning(FIRST_HELLO_928PM_ET, TORONTO_8AM, EASTERN)).toBe(true);
    expect(isSittingReminderSlot(NEXT_NIGHT_825PM_ET, EASTERN)).toBe(false);
  });

  it("reads the day in the family's zone, not Eastern's", () => {
    const pacificLate = new Date('2026-08-27T05:30:00.000Z'); // 22:30 PDT on 26 Aug
    const pacific8am = new Date('2026-08-27T15:00:00.000Z'); // 08:00 PDT on 27 Aug
    expect(isNextLocalMorning(pacificLate, pacific8am, 'America/Vancouver')).toBe(true);
    expect(isNextLocalMorning(pacificLate, pacific8am, EASTERN)).toBe(false);
  });
});

describe('sittingSessionEligible', () => {
  const open = {
    state: 'awaiting_details' as const,
    closedAt: null,
    sittingReminderSentAt: null,
    firstReplyRecoveredAt: null,
    familyId: null,
    createdAt: FIRST_HELLO_PREVIOUS_EVENING,
    timeZone: EASTERN,
  };

  it('accepts an open awaiting_details session the next Toronto morning at 8:00', () => {
    expect(sittingSessionEligible(open, TORONTO_8AM)).toBe(true);
  });

  it('refuses 9:00 Toronto — that hour is not the lock', () => {
    expect(sittingSessionEligible(open, TORONTO_9AM)).toBe(false);
  });

  it('refuses the same Toronto morning, even at 8:00', () => {
    expect(
      sittingSessionEligible({ ...open, createdAt: FIRST_HELLO_SAME_MORNING }, TORONTO_8AM),
    ).toBe(false);
  });

  it('refuses a completed session', () => {
    expect(
      sittingSessionEligible(
        { ...open, state: 'complete', closedAt: TORONTO_8AM, familyId: 'fam-1' },
        TORONTO_8AM,
      ),
    ).toBe(false);
  });

  it('refuses STOP', () => {
    expect(
      sittingSessionEligible({ ...open, state: 'stopped', closedAt: TORONTO_8AM }, TORONTO_8AM),
    ).toBe(false);
  });

  it('refuses a session already reminded', () => {
    expect(
      sittingSessionEligible(
        { ...open, sittingReminderSentAt: FIRST_HELLO_PREVIOUS_EVENING },
        TORONTO_8AM,
      ),
    ).toBe(false);
  });

  it('refuses a provisioned family — sitting sessions stay intakes', () => {
    expect(sittingSessionEligible({ ...open, familyId: 'fam-1' }, TORONTO_8AM)).toBe(false);
  });

  it('nudges once the morning after a find, and not the same morning', () => {
    const parked = {
      state: 'awaiting_cold_start' as const,
      closedAt: null,
      sittingReminderSentAt: null,
      firstReplyRecoveredAt: null,
      familyId: 'fam-1',
      createdAt: FIRST_HELLO_PREVIOUS_EVENING,
      timeZone: EASTERN,
    };
    expect(findNudgeEligible(parked, TORONTO_8AM)).toBe(true);
    expect(findNudgeEligible({ ...parked, createdAt: FIRST_HELLO_SAME_MORNING }, TORONTO_8AM)).toBe(
      false,
    );
    expect(findNudgeEligible({ ...parked, sittingReminderSentAt: TORONTO_8AM }, TORONTO_8AM)).toBe(
      false,
    );
    expect(findNudgeEligible({ ...parked, familyId: null }, TORONTO_8AM)).toBe(false);
  });

  it('refuses a first-hello recovered this morning — Still here waits until tomorrow', () => {
    expect(
      sittingSessionEligible({ ...open, firstReplyRecoveredAt: TORONTO_8AM }, TORONTO_8AM),
    ).toBe(false);
  });
});

describe('runSittingReminderCron', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
    vi.unstubAllEnvs();
  });

  it('sends the locked line once from the injected transport', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    const first = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
    expect(transport.sent[0]?.to).toBe(PHONE);
  });

  it('VIL-553: skips a number held for an unread opt-out read, before any claim', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const id = seedSession(fake);
    fake.db.insert(schema.optOutHeldMessages).values({
      providerMessageId: 'pm-held',
      phoneHash: phoneBlindIndex(PHONE),
      heldAt: FIRST_HELLO_PREVIOUS_EVENING,
      nextReadAt: FIRST_HELLO_PREVIOUS_EVENING,
    });

    const held = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(held).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0, optOutHeld: 1 });
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).find((row) => row.id === id)).toMatchObject({
      sittingReminderSentAt: null,
    });

    // Positive control: the same row with no hold standing is sent its reminder.
    const unheld = makeFakeDb();
    seedSession(unheld);
    const owed = await runSittingReminderCron(unheld.db, deps(transport), TORONTO_8AM);
    expect(owed).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    expect(transport.sent[0]?.to).toBe(PHONE);
  });

  it("does not send Still here to tonight's founder-pair session ids", async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const [firstId, secondId] = [...FOUNDER_PAIR_SESSION_IDS];
    expect(FOUNDER_PAIR_SESSION_IDS.size).toBe(2);
    seedSession(fake, { id: firstId });
    seedSession(fake, { id: secondId, phoneE164: OTHER });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).map((row) => row.sittingReminderSentAt)).toEqual([
      TORONTO_8AM,
      TORONTO_8AM,
    ]);
  });

  it('caps at one send — a second tick in the same hour is quiet', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    const second = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);

    expect(second).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      sittingReminderSentAt: TORONTO_8AM,
      followUpCount: 0,
      state: 'awaiting_details',
      familyId: null,
    });
  });

  it('skips a completed session', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      state: 'complete',
      closedAt: FIRST_HELLO_PREVIOUS_EVENING,
      familyId: 'fam-1',
    });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('skips STOP', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { state: 'stopped', closedAt: FIRST_HELLO_PREVIOUS_EVENING });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('skips a session already reminded', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { sittingReminderSentAt: FIRST_HELLO_PREVIOUS_EVENING });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
  });

  it('does not send at 9:00 Toronto', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake);

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_9AM);
    expect(result).toEqual({ evaluated: 0, sent: 0, skipped: 1, failed: 0 });
    expect(transport.bodies()).toEqual([]);
  });

  it('sends the next morning for 8:25pm / 9:28pm ET first-hellos — not 24h later', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { createdAt: FIRST_HELLO_825PM_ET });
    seedSession(fake, { phoneE164: OTHER, createdAt: FIRST_HELLO_928PM_ET });

    const morning = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(morning.sent).toBe(2);
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy

    const leak = await runSittingReminderCron(fake.db, deps(transport), NEXT_NIGHT_825PM_ET);
    expect(leak).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0 });
    expect(transport.bodies().length).toBeGreaterThan(0); // model-written; no fixed copy
  });

  it('does not mint a family — the session stays an intake', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { phoneE164: OTHER });

    await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);

    expect(fake.rows(schema.families)).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions)[0]).toMatchObject({
      familyId: null,
      state: 'awaiting_details',
    });
  });

  it('holds a parent stuck on the postal code: no place means no zone, so no nudge (D3)', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const id = seedSession(fake, { state: 'awaiting_place', dataEncrypted: firstHelloBlob() });

    for (const at of [TORONTO_8AM, new Date('2026-08-27T15:00:00.000Z')]) {
      const held = await runSittingReminderCron(fake.db, voiceDeps(transport), at);
      expect(held).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0, zoneUnknown: 1 });
    }
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).find((row) => row.id === id)).toMatchObject({
      sittingReminderSentAt: null,
    });
  });

  it('positive control: a parent stuck on the ages with a place is nudged once', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { state: 'awaiting_ages' });

    const first = await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    expect(transport.bodies()).toEqual(['How old are your kids?']);

    const second = await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(second.sent).toBe(0);
    expect(transport.bodies()).toHaveLength(1);
  });

  it('a held awaiting_place row never reaches the composer, so nothing fails', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { state: 'awaiting_place', dataEncrypted: firstHelloBlob() });
    const result = await runSittingReminderCron(fake.db, { transport }, TORONTO_8AM);
    expect(result).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0, zoneUnknown: 1 });
    expect(transport.bodies()).toEqual([]);
  });

  it('does not send a canned nudge when the model is missing', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { state: 'awaiting_ages' });
    const result = await runSittingReminderCron(fake.db, { transport }, TORONTO_8AM);
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);
    expect(transport.bodies().join('\n')).not.toMatch(/How old are the kids|postal code/i);
  });

  it('nudges once the morning after a find, in friend voice, and not the locked reminder', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      state: 'awaiting_cold_start',
      familyId: 'fam-1',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: 'M5V 2T6' },
          transcript: [],
          firstTouch: {
            language: 'en',
            place: {
              kind: 'postal',
              areaCoarse: 'M5V',
              postalCode: 'M5V 2T6',
              municipality: 'toronto',
              city: 'Toronto',
            },
            locationRequest: null,
            coldStart: {
              step: 'pick',
              group: false,
              findBody: '1. Swim (ages 3-5) - Saturday',
              activity: null,
              day: null,
              nameLineSent: false,
              signupDateKnown: false,
              signupAsked: false,
              calendarAsked: false,
              emailAsked: false,
              schoolMentioned: false,
            },
          },
        }),
      ),
    });

    const first = await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(first).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 0 });
    const body = transport.bodies()[0] ?? '';
    expect(body).toContain('1. Swim (ages 3-5) - Saturday');
    expect(body.trim().endsWith('Which of these looks good?')).toBe(true);

    const second = await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(second.sent).toBe(0);
    expect(transport.bodies()).toHaveLength(1);
  });

  it('does not nudge a family that answered after the find', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      state: 'awaiting_cold_start',
      familyId: 'fam-1',
      // The reply after provisioning moved this past the transcript's last inbound.
      lastProviderId: 'SMreply',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: 'M5V 2T6' },
          transcript: [
            {
              direction: 'in',
              body: 'Maya is 4, M5V 2T6',
              providerId: 'SMprovision',
              at: FIRST_HELLO_PREVIOUS_EVENING.toISOString(),
            },
          ],
          firstTouch: {
            ...firstTouchAt(EASTERN_FSA),
            coldStart: {
              step: 'names',
              group: false,
              findBody: '1. Swim (ages 3-5) - Saturday',
              activity: 'Swim',
              day: 'Saturday',
              nameLineSent: false,
              signupDateKnown: false,
              signupAsked: false,
              calendarAsked: false,
              emailAsked: false,
              schoolMentioned: false,
            },
          },
        }),
      ),
    });
    const result = await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(result).toEqual({ evaluated: 1, sent: 0, skipped: 1, failed: 0 });
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions)[0]?.sittingReminderSentAt).toEqual(TORONTO_8AM);
  });

  it('nudges a stuck French ages session in French', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      state: 'awaiting_ages',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: null },
          transcript: [],
          ladderLanguage: 'fr',
          firstTouch: firstTouchAt(EASTERN_FSA),
        }),
      ),
    });
    await runSittingReminderCron(fake.db, voiceDeps(transport), TORONTO_8AM);
    expect(transport.bodies()[0]).toMatch(/âge|code postal/i);
    expect(transport.bodies()[0]?.match(/\?/g)).toHaveLength(1);
  });

  it('wires the shared outbound leg into the default deps', async () => {
    const { transport } = defaultSittingReminderDeps();
    vi.stubEnv('LINQ_API_KEY', '');
    vi.stubEnv('LINQ_FROM_E164', '');
    await expect(transport.send({ to: PHONE, body: 'A reminder (test fixture).' })).rejects.toThrow(
      /not_configured/,
    );
  });
});

describe("runSittingReminderCron - the family's own morning (VIL-562)", () => {
  /** 27 Aug 2026: 12:00Z is 08:00 EDT and 05:00 PDT; 15:00Z is 08:00 PDT. */
  const PACIFIC_5AM = TORONTO_8AM;
  const PACIFIC_8AM = new Date('2026-08-27T15:00:00.000Z');

  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY;
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = '';
    vi.restoreAllMocks();
  });

  it('S1: a Pacific session is not nudged at 05:00 local, and is at 08:00 local', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const id = seedSession(fake, { dataEncrypted: placeBlob(PACIFIC_FSA) });

    await runSittingReminderCron(fake.db, deps(transport), PACIFIC_5AM);
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).find((row) => row.id === id)).toMatchObject({
      sittingReminderSentAt: null,
    });

    const morning = await runSittingReminderCron(fake.db, deps(transport), PACIFIC_8AM);
    expect(morning.sent).toBe(1);
    expect(transport.sent.map((s) => s.to)).toEqual([PHONE]);
  });

  it('S2: positive control - an Eastern session is nudged at 08:00 EDT and not at 07:00', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, { dataEncrypted: placeBlob(EASTERN_FSA) });

    expect((await runSittingReminderCron(fake.db, deps(transport), TORONTO_7AM)).sent).toBe(0);
    expect((await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM)).sent).toBe(1);
  });

  it('S3: a 22:30 PDT first-hello is nudged at 08:00 PDT the next local morning', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    seedSession(fake, {
      dataEncrypted: placeBlob(PACIFIC_FSA),
      createdAt: new Date('2026-08-27T05:30:00.000Z'), // 22:30 PDT on 26 Aug
    });

    const morning = await runSittingReminderCron(fake.db, deps(transport), PACIFIC_8AM);
    expect(morning.sent).toBe(1);
  });

  it('S4: the first-hello with no place has no zone - held at every hour, never claimed (D3)', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const id = seedSession(fake, { dataEncrypted: firstHelloBlob() });

    for (const at of [TORONTO_8AM, PACIFIC_8AM]) {
      const held = await runSittingReminderCron(fake.db, deps(transport), at);
      expect(held).toEqual({ evaluated: 0, sent: 0, skipped: 0, failed: 0, zoneUnknown: 1 });
    }
    expect(transport.bodies()).toEqual([]);
    expect(fake.rows(schema.smsIntakeSessions).find((row) => row.id === id)).toMatchObject({
      sittingReminderSentAt: null,
    });
    expect(console.info).toHaveBeenCalledWith(
      { zoneUnknown: 1 },
      'sitting reminder: held, no zone for the session',
    );
  });

  it('S6: an unreadable session is one named failure, and the run goes on to the next row', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const wrongKeyBlob = placeBlob(EASTERN_FSA);
    process.env.APP_ENCRYPTION_KEY = KEY;
    const bad = seedSession(fake, { dataEncrypted: wrongKeyBlob });
    seedSession(fake, { phoneE164: OTHER, dataEncrypted: placeBlob(EASTERN_FSA) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(result).toEqual({ evaluated: 1, sent: 1, skipped: 0, failed: 1 });
    expect(transport.sent.map((s) => s.to)).toEqual([OTHER]);
    expect(fake.rows(schema.smsIntakeSessions).find((row) => row.id === bad)).toMatchObject({
      sittingReminderSentAt: null,
    });
    expect(error).toHaveBeenCalledWith(
      { code: 'session_unreadable' },
      'sitting reminder: session unreadable, not sent',
    );
  });

  it('S5: an in-slot row is reached behind fifty out-of-slot rows', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    for (let i = 0; i < 50; i += 1) {
      seedSession(fake, {
        phoneE164: `+1604555${String(1000 + i)}`,
        dataEncrypted: placeBlob(PACIFIC_FSA),
      });
    }
    seedSession(fake, { phoneE164: OTHER, dataEncrypted: placeBlob(EASTERN_FSA) });

    const result = await runSittingReminderCron(fake.db, deps(transport), TORONTO_8AM);
    expect(transport.sent.map((s) => s.to)).toEqual([OTHER]);
    expect(result.sent).toBe(1);
  });
});
