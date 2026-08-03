import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchHealthCheckpoints } from '~/lib/health/match';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  AMBIGUOUS_CLARIFY,
  ASSENT_ACK,
  DECLINE_ACK,
  HELP_REPLY,
  REGION_UNAVAILABLE_REPLY,
  STOP_ACK,
  WATCH_OFFER,
  detailsBlocked,
} from './copy';
import { FakeExtractor, FakeIntentReader, type FakeDb, fakeRadar, makeFakeDb } from './fakes';
import type { IntakeCollected } from './extract';
import type { IntentReading } from './intent';
import { type IntakeDeps, handleInboundSms } from './machine';
import { FakeTransport } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

const MAYA_AND_LEO: IntakeCollected = {
  children: [
    { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    { name: 'Leo', ageMonths: 12, agePrecision: 'years' },
  ],
  postalCode: 'M5V 2T6',
};

const NO_POSTAL: IntakeCollected = { children: MAYA_AND_LEO.children, postalCode: null };

function assent(reply: string): IntentReading {
  return { intent: 'assent', verbatim: reply, interpretation: 'plain yes' };
}
function decline(reply: string): IntentReading {
  return { intent: 'decline', verbatim: reply, interpretation: 'plain no' };
}
function ambiguous(reply: string): IntentReading {
  return { intent: 'ambiguous', verbatim: reply, interpretation: 'a question back' };
}

/** The M5V (downtown Toronto) FSA centroid the fake geocoder returns, so the
 * seeding assertions can tell "placed here" from "could not be placed". */
const M5V_CENTRE = { lat: 43.6426, lng: -79.3871 };

function harness(options: {
  extractions?: IntakeCollected[];
  intents?: IntentReading[];
  limiter?: FakeRateLimiter;
  resolveCenter?: IntakeDeps['resolveCenter'];
}): {
  fake: FakeDb;
  transport: FakeTransport;
  deps: IntakeDeps;
  /** Every seeding/compose step, in the order the machine ran them. */
  steps: string[];
} {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const steps: string[] = [];
  return {
    fake,
    transport,
    steps,
    deps: {
      transport,
      extractor: new FakeExtractor(options.extractions ?? [MAYA_AND_LEO]),
      intentReader: new FakeIntentReader(options.intents ?? [assent('yes')]),
      radar: {
        async compose(input) {
          steps.push(`radar:${input.areaCoarse}`);
          return fakeRadar.compose(input);
        },
      },
      seedCivic: async (_db, familyId, areaCoarse, center) => {
        const placed = center === null ? 'unplaced' : `${center.lat},${center.lng}`;
        steps.push(`civic:${familyId ? 'family' : 'none'}:${areaCoarse}:${placed}`);
        return 0;
      },
      resolveCenter: options.resolveCenter ?? (async () => M5V_CENTRE),
      discoveryTrigger: (familyId) => {
        steps.push(`discovery:${familyId ? 'family' : 'none'}`);
      },
      limiter: options.limiter ?? new FakeRateLimiter(() => NOW.getTime()),
      now: NOW,
    },
  };
}

/** Drive one inbound text through the machine. */
function text(
  fake: FakeDb,
  transport: FakeTransport,
  deps: IntakeDeps,
  body: string,
  override?: IntakeDeps,
) {
  return handleInboundSms(fake.db, transport.inbound(PHONE, body), override ?? deps);
}

function inserts(fake: FakeDb, table: unknown) {
  return fake.writes.filter((w) => w.op === 'insert' && w.table === table).map((w) => w.payload);
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
});

describe('intake · happy path', () => {
  it('greets, provisions the family field-by-field, offers the watch, and records assent', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes please')] });

    expect(await text(fake, transport, deps, 'hi')).toEqual({ status: 'greeted' });
    expect(transport.bodies()[0]).toContain("I keep family weeks on track for GTA parents");
    // The disclosure rides on the first reply, once.
    expect(transport.bodies()[0]).toContain("I'm an assistant, not a person");

    const provisioned = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(provisioned.status).toBe('provisioned');

    // ── the family, field by field ──
    const [family] = inserts(fake, schema.families);
    expect(family).toMatchObject({
      displayName: "Maya's family",
      onboardingStage: 'sms_intake', // NOT sms_active — the watch offer is unanswered
      country: 'Canada',
      postalCode: 'M5V 2T6',
      areaCoarse: 'M5V',
    });

    // ── the parent: no email, and the raw number nowhere in plaintext ──
    const [user] = inserts(fake, schema.users);
    expect(user?.email).toBeNull();
    expect(user?.externalAuthId).toMatch(/^sms:[0-9a-f]{64}$/);
    const everythingWritten = JSON.stringify(fake.writes.map((w) => w.payload));
    expect(everythingWritten).not.toContain(PHONE);
    expect(everythingWritten).not.toContain('4165551234');

    // ── the children: DOB derived from the stated age, and stamped as derived ──
    const kids = inserts(fake, schema.children);
    expect(kids).toEqual([
      // Both ages were stated in bare YEARS ("Maya is 4, Leo is 1"), so each covers a
      // 12-month band and the stored date is its midpoint: 48 + 6 and 12 + 6 back.
      { familyId: expect.any(String), name: 'Maya', dateOfBirth: '2022-01-30', dobPrecision: 'derived' },
      { familyId: expect.any(String), name: 'Leo', dateOfBirth: '2025-01-30', dobPrecision: 'derived' },
    ]);

    // ── the channel: verified by origination, hashed + encrypted ──
    const [channel] = inserts(fake, schema.parentChannels);
    expect(channel).toMatchObject({ kind: 'sms', verifiedAt: NOW });
    expect(channel?.phoneE164Hash).toMatch(/^[0-9a-f]{64}$/);
    expect(channel?.phoneE164Encrypted).not.toContain('416');

    // ── the watch offer went out ──
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);

    const answered = await text(fake, transport, deps, 'yes please');
    expect(answered).toEqual({ status: 'watch_recorded', intent: 'assent', granted: true });
    expect(transport.bodies().at(-1)).toBe(ASSENT_ACK);
  });

  it('records the consent evidence BEFORE the family is flipped to sms_active', async () => {
    const { fake, transport, deps } = harness({ intents: [assent('yes!')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'yes!');

    const consentIndex = fake.writes.findIndex(
      (w) =>
        w.op === 'insert' &&
        w.table === schema.consentRecords &&
        w.payload.consentType === 'proactive_watch',
    );
    const flipIndex = fake.writes.findIndex(
      (w) =>
        w.op === 'update' &&
        w.table === schema.families &&
        w.payload.onboardingStage === 'sms_active',
    );
    expect(consentIndex).toBeGreaterThanOrEqual(0);
    expect(flipIndex).toBeGreaterThan(consentIndex);

    const consent = fake.writes[consentIndex]?.payload as Record<string, unknown>;
    expect(consent.granted).toBe(true);
    expect(consent.evidence).toMatchObject({
      question: WATCH_OFFER,
      verbatimReply: 'yes!',
      interpretation: 'plain yes',
      channelMessageId: expect.any(String),
    });
  });

  it('records a DECLINE as a granted=false consent row, not as an absent one', async () => {
    const { fake, transport, deps } = harness({ intents: [decline('no thanks')] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    const result = await text(fake, transport, deps, 'no thanks');

    expect(result).toEqual({ status: 'watch_recorded', intent: 'decline', granted: false });
    expect(transport.bodies().at(-1)).toBe(DECLINE_ACK);
    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
  });
});

/**
 * VIL-260 · WS1 — the age a parent SPOKE has to be the age Hale reads back.
 *
 * A stated age is a band, and only a bare year count ("she's four") is 12 months wide.
 * "18 months" is a point the parent already narrowed for us, so aging it by another
 * half-year is not a midpoint, it is an error — and an unrecoverable one, because every
 * downstream consumer re-derives the age OUT of the stored date.
 */
describe('intake · the age the parent stated', () => {
  /** Read a child row back the way production does: age out of the stored date. */
  function storedAge(fake: FakeDb, index = 0): number {
    const row = inserts(fake, schema.children)[index] as { dateOfBirth: string };
    return ageInMonths(row.dateOfBirth, NOW);
  }

  it('stores "18 months" as eighteen months, and the 18-month checkpoints fire for her', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        {
          children: [{ name: 'Mia', ageMonths: 18, agePrecision: 'months' }],
          postalCode: 'L3R',
        },
      ],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Mia is 18 months, L3R');
    expect(result.status).toBe('provisioned');

    expect(storedAge(fake)).toBe(18);

    // The reason it matters: both 18-month rows are minMonths 18 / maxMonths 23, and
    // the matcher never widens the LATE edge. A child stored at 24 can never be shown
    // Ontario's Enhanced 18-month well-baby visit, and only ages further past it.
    const matches = matchHealthCheckpoints({
      children: [
        {
          id: 'child-1',
          name: 'Mia',
          ageMonths: storedAge(fake),
          dobPrecision: 'derived',
          isTeen: false,
        },
      ],
      areaCoarse: 'L3R',
      suppressedRefs: new Set<string>(),
      now: NOW,
    });
    expect(matches.map((m) => m.checkpoint.id).sort()).toEqual([
      'immunization_18_months',
      'well_baby_18_months',
    ]);
  });

  it('leaves a bare year statement on its band midpoint, where the half-year IS the estimate', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: 'Ines', ageMonths: 48, agePrecision: 'years' }], postalCode: 'L3R' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Ines is 4, L3R');
    // "she's four" is anywhere in [48, 60): 54 is the read with the smallest worst case.
    expect(storedAge(fake)).toBe(54);
  });

  it('does not age a six-week-old into a seven-month-old', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: null, ageMonths: 1, agePrecision: 'months' }], postalCode: 'L7G' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'just one, she was born 6 weeks ago. L7G');
    expect(storedAge(fake)).toBe(1);
  });

  it('keeps a preschooler a toddler: "3 and a half" does not cross the 48-month stage line', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        { children: [{ name: 'Ben', ageMonths: 42, agePrecision: 'months' }], postalCode: 'L3R' },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Ben is 3 and a half, L3R');
    expect(storedAge(fake)).toBe(42);
    expect(storedAge(fake)).toBeLessThan(48);
  });
});

/**
 * VIL-260 · WS1 — a child whose age we were never told.
 *
 * The old path invented one (`deriveDateOfBirth(0)` — a six-month-old), which is the
 * one thing this module refuses to do everywhere else: it will not complete a postal
 * code, will not guess a country, and will not invent a name. An age is no different,
 * and it is worse in consequence, because the invented date is what every checkpoint,
 * stage and registration band is computed from afterwards.
 */
describe('intake · a child with no age', () => {
  const NAMES_ONLY: IntakeCollected = {
    children: [
      { name: 'Nora', ageMonths: null, agePrecision: null },
      { name: 'Ben', ageMonths: null, agePrecision: null },
    ],
    postalCode: 'M5V 2T6',
  };

  it('provisions NOTHING and spends the one follow-up asking for the ages', async () => {
    const { fake, transport, deps } = harness({ extractions: [NAMES_ONLY] });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Nora and Ben, M5V');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe('Got it - Nora and Ben. How old are they?');
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('provisions once the ages arrive, with the ages the parent actually gave', async () => {
    const { fake, transport, deps } = harness({
      extractions: [
        NAMES_ONLY,
        {
          children: [
            { name: 'Nora', ageMonths: 48, agePrecision: 'years' },
            { name: 'Ben', ageMonths: 18, agePrecision: 'months' },
          ],
          postalCode: 'M5V 2T6',
        },
      ],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Nora and Ben, M5V');
    const provisioned = await text(fake, transport, deps, '4 and 18 months');

    expect(provisioned.status).toBe('provisioned');
    expect(inserts(fake, schema.children)).toEqual([
      { familyId: expect.any(String), name: 'Nora', dateOfBirth: '2022-01-30', dobPrecision: 'derived' },
      { familyId: expect.any(String), name: 'Ben', dateOfBirth: '2025-01-30', dobPrecision: 'derived' },
    ]);
  });

  it('states the blocker once and then goes quiet, exactly as a missing postal code does', async () => {
    const { fake, transport, deps } = harness({ extractions: [NAMES_ONLY] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Nora and Ben, M5V');
    const before = transport.bodies().length;

    const second = await text(fake, transport, deps, "they're little");
    expect(second).toEqual({ status: 'details_blocked', missing: ['ages'] });
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(transport.bodies().at(-1)).toBe(detailsBlocked(['ages']));

    const third = await text(fake, transport, deps, 'still little');
    expect(third).toEqual({ status: 'details_blocked', missing: ['ages'] });
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('holds the venue-QR single-message path too, where the area needs no asking', async () => {
    // A QR first message carries the venue's own area, so the ONLY thing outstanding is
    // the ages — and that path reached provisioning in one message before this gate.
    const { fake, transport, deps } = harness({
      extractions: [{ children: NAMES_ONLY.children, postalCode: null }],
    });
    await text(fake, transport, deps, 'HALE LIBRARY');

    const asked = await text(fake, transport, deps, 'Nora and Ben');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe('Got it - Nora and Ben. How old are they?');
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('asks for both in ONE message when the ages and the postal code are missing', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: NAMES_ONLY.children, postalCode: null }],
    });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Nora and Ben');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe(
      "Got it - Nora and Ben. How old are they, and what's your postal code?",
    );
  });
});

/**
 * VIL-260 · WS1 — the first reply is the one message a stranger is guaranteed to read,
 * and a family four milliseconds old has nothing on file for it to be built from.
 */
describe('intake · seeding the first radar', () => {
  it('places the family near its civic sessions BEFORE composing, and kicks discovery', async () => {
    const { fake, transport, deps, steps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    // Order is the assertion: an inline projection composed AFTER the radar could not
    // have reached it, which is exactly the bug. The centroid rides along, so the
    // FIRST radar is distance-filtered like every later one (VIL-260 · WS5).
    expect(steps).toEqual([
      `civic:family:M5V:${M5V_CENTRE.lat},${M5V_CENTRE.lng}`,
      'discovery:family',
      'radar:M5V',
    ]);
  });

  it('still seeds — unplaced — when the coarse area cannot be geocoded', async () => {
    // A Places miss must cost this family PROXIMITY, not their first radar: an
    // unplaced projection still has its municipality gate to fall back on.
    const { fake, transport, deps, steps } = harness({ resolveCenter: async () => null });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(steps).toEqual(['civic:family:M5V:unplaced', 'discovery:family', 'radar:M5V']);
  });

  it('seeds unplaced rather than dying when the geocoder itself throws', async () => {
    const { fake, transport, deps, steps } = harness({
      resolveCenter: async () => {
        throw new Error('places quota exhausted');
      },
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    expect(result.status).toBe('provisioned');
    expect(steps).toEqual(['civic:family:M5V:unplaced', 'discovery:family', 'radar:M5V']);
  });

  it('never lets a seeding failure cost a family their intake', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6', {
      ...deps,
      seedCivic: async () => {
        throw new Error('civic sessions table is unreachable');
      },
      discoveryTrigger: () => {
        throw new Error('no request scope');
      },
    });

    expect(result.status).toBe('provisioned');
    expect(transport.bodies().at(-1)).toContain(WATCH_OFFER);
  });

  it('does not seed anything for a conversation that never provisioned', async () => {
    const { fake, transport, deps, steps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '10001' }],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya 4, Leo 1, 10001');
    expect(steps).toEqual([]);
  });
});

describe('intake · the one follow-up', () => {
  it('asks exactly one targeted follow-up when only the postal code is missing', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL, MAYA_AND_LEO] });
    await text(fake, transport, deps, 'hi');

    const asked = await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    expect(asked).toEqual({ status: 'follow_up_asked' });
    expect(transport.bodies().at(-1)).toBe("Got it - Maya (4) and Leo (1). What's your postal code?");

    const provisioned = await text(fake, transport, deps, 'M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('never asks a second time — it states the blocker once, then goes quiet', async () => {
    const { fake, transport, deps } = harness({ extractions: [NO_POSTAL] });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4 and Leo is 1');
    const before = transport.bodies().length;

    const second = await text(fake, transport, deps, "I'd rather not say");
    expect(second).toEqual({ status: 'details_blocked', missing: ['location'] });
    // One blocker line, and it is NOT the follow-up question again.
    expect(transport.bodies()).toHaveLength(before + 1);
    expect(transport.bodies().at(-1)).toBe(detailsBlocked(['location']));
    expect(transport.bodies().at(-1)).not.toContain("What's your postal code?");

    const third = await text(fake, transport, deps, 'still not saying');
    expect(third).toEqual({ status: 'details_blocked', missing: ['location'] });
    expect(transport.bodies()).toHaveLength(before + 1); // silence, not a third ask
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });
});

describe('intake · a bare FSA', () => {
  it('provisions on an FSA alone, as the coarse area with no full postal code (D2)', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: 'l3r' }],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya is 4, Leo is 1, we are over in l3r');

    expect(result.status).toBe('provisioned');
    expect(inserts(fake, schema.families)[0]).toMatchObject({
      country: 'Canada',
      postalCode: null,
      areaCoarse: 'L3R',
    });
    // The two wrong answers this fixture exists to rule out: asking for the postal
    // code we were just given, and refusing a Markham family as out-of-region.
    expect(transport.bodies()).not.toContain(detailsBlocked(['location']));
    expect(transport.bodies()).not.toContain(REGION_UNAVAILABLE_REPLY);
  });
});

describe('intake · the region gate', () => {
  it('refuses a non-Canadian postal code and provisions NOTHING', async () => {
    const { fake, transport, deps } = harness({
      extractions: [{ children: MAYA_AND_LEO.children, postalCode: '10001' }],
    });
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'Maya 4, Leo 1, 10001');

    expect(result).toEqual({ status: 'region_unavailable' });
    expect(transport.bodies().at(-1)).toBe(REGION_UNAVAILABLE_REPLY);
    expect(inserts(fake, schema.families)).toHaveLength(0);
    expect(inserts(fake, schema.children)).toHaveLength(0);
    expect(inserts(fake, schema.parentChannels)).toHaveLength(0);
  });
});

describe('intake · ambiguity', () => {
  it('clarifies once, then records a conservative NO rather than guessing yes', async () => {
    const { fake, transport, deps } = harness({
      intents: [ambiguous('what would you even watch?'), ambiguous('hmm')],
    });
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const clarified = await text(fake, transport, deps, 'what would you even watch?');
    expect(clarified).toEqual({ status: 'clarified' });
    expect(transport.bodies().at(-1)).toBe(AMBIGUOUS_CLARIFY);

    const resolved = await text(fake, transport, deps, 'hmm');
    expect(resolved).toEqual({ status: 'watch_recorded', intent: 'ambiguous', granted: false });
    // Only ONE clarification, ever.
    expect(transport.bodies().filter((b) => b === AMBIGUOUS_CLARIFY)).toHaveLength(1);

    const watch = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'proactive_watch',
    );
    expect(watch?.granted).toBe(false);
    expect((watch?.evidence as Record<string, unknown>).interpretation).toContain('recorded as no');
  });
});

describe('intake · CASL keywords', () => {
  it('STOP before provisioning acks and provisions nothing', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const result = await text(fake, transport, deps, 'STOP');

    expect(result).toEqual({ status: 'stopped' });
    expect(transport.bodies().at(-1)).toBe(STOP_ACK);
    expect(inserts(fake, schema.families)).toHaveLength(0);
  });

  it('STOP after provisioning revokes the channel and appends a consent withdrawal', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');

    const result = await text(fake, transport, deps, 'unsubscribe');
    expect(result).toEqual({ status: 'stopped' });

    const revoke = fake.writes.find(
      (w) => w.op === 'update' && w.table === schema.parentChannels && w.payload.revokedAt,
    );
    expect(revoke).toBeDefined();
    const withdrawal = inserts(fake, schema.consentRecords).find(
      (c) => c.consentType === 'sms_service_messages' && c.granted === false,
    );
    expect(withdrawal).toBeDefined();
  });

  it('never routes a keyword through the model', async () => {
    const extractor = new FakeExtractor([MAYA_AND_LEO]);
    const intentReader = new FakeIntentReader([assent('yes')]);
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const deps: IntakeDeps = {
      transport,
      extractor,
      intentReader,
      radar: fakeRadar,
      limiter: new FakeRateLimiter(() => NOW.getTime()),
      now: NOW,
    };
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'STOP');
    // The greeting turn never extracts either — only the details turn does.
    expect(extractor.calls).toHaveLength(0);
    expect(intentReader.calls).toHaveLength(0);
  });

  it('HELP answers with the capability line without ending the conversation', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    const helped = await text(fake, transport, deps, 'HELP');
    expect(helped).toEqual({ status: 'helped' });
    expect(transport.bodies().at(-1)).toBe(HELP_REPLY);

    // Still mid-intake: the next real answer still provisions.
    const provisioned = await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    expect(provisioned.status).toBe('provisioned');
  });

  it('START after a STOP re-enrols on the keyword itself, keeping the revoked row', async () => {
    const { fake, transport, deps } = harness({});
    await text(fake, transport, deps, 'hi');
    await text(fake, transport, deps, 'Maya is 4, Leo is 1. M5V 2T6');
    await text(fake, transport, deps, 'STOP');

    const restarted = await text(fake, transport, deps, 'START');
    expect(restarted).toEqual({ status: 'restarted' });

    const channels = inserts(fake, schema.parentChannels);
    expect(channels).toHaveLength(2); // a NEW row, never an un-revoke of the old one
    const consents = inserts(fake, schema.consentRecords).filter(
      (c) => c.consentType === 'sms_service_messages' && c.granted === true,
    );
    expect(consents.at(-1)?.evidence).toMatchObject({
      verbatimReply: 'START',
      interpretation: 'CASL START keyword sent from the number itself',
    });
  });
});

describe('intake · guards', () => {
  it('goes silent over the per-number rate limit — never replies to a flood', async () => {
    const limiter = new FakeRateLimiter(() => NOW.getTime());
    const { fake, transport, deps } = harness({ limiter });
    // Burn the hourly allowance on this number.
    for (let i = 0; i < 30; i += 1) {
      await limiter.check(
        // The machine keys on the blind index; any consistent key exercises the window.
        (await import('~/lib/crypto/blind-index')).phoneBlindIndex(PHONE),
        'sms-inbound',
        { limit: 30, windowSec: 3600 },
      );
    }

    const result = await text(fake, transport, deps, 'hi');
    expect(result).toEqual({ status: 'rate_limited' });
    expect(transport.sent).toHaveLength(0);
    expect(fake.writes).toHaveLength(0);
  });

  it('treats a carrier retry of the same provider id as a no-op', async () => {
    const { fake, transport, deps } = harness({});
    const first = transport.inbound(PHONE, 'hi');
    await handleInboundSms(fake.db, first, deps);
    const sentAfterFirst = transport.sent.length;
    const writesAfterFirst = fake.writes.length;

    const retry = await handleInboundSms(fake.db, { ...first }, deps);
    expect(retry).toEqual({ status: 'duplicate' });
    expect(transport.sent).toHaveLength(sentAfterFirst);
    expect(fake.writes).toHaveLength(writesAfterFirst);
  });

  it('ignores a number it cannot canonicalize (there is nobody to answer)', async () => {
    const { fake, transport, deps } = harness({});
    const result = await handleInboundSms(fake.db, transport.inbound('12345', 'hi'), deps);
    expect(result).toEqual({ status: 'ignored', reason: 'invalid_number' });
    expect(transport.sent).toHaveLength(0);
  });
});
