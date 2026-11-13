/**
 * VIL-520 · Carpool reader fixtures. Each `input` is a group message as the runtime hands
 * it to the `carpool-reading` skill (apps/web/lib/channel/linq/carpool-reading.ts,
 * `carpoolUserMessage`). `expect` is what the parsed reading must hold, plus the pickup
 * instant the runtime's own `resolveCarpoolPickup` turns it into:
 *   - `intent`, `driverName`: accepted values (driverName null = nobody drives);
 *   - `pickupDate`: the local day, or null when none was said or the named days disagree;
 *   - `pickupTime`: graded only when present;
 *   - `pickupAt`: ISO instant, or null.
 * Every `now` is one of the fixed clocks below, never the wall clock.
 */

export const CARPOOL_EVAL_CLOCKS = {
  /** Fri Oct 30 2026, 21:30 in Toronto (EDT). UTC is already Saturday. */
  fridayNightToronto: new Date('2026-10-31T01:30:00Z'),
  /** Sun Nov 1 2026, 22:30 in Toronto (EST, after fall-back). Tomorrow is Monday. */
  sundayNightToronto: new Date('2026-11-02T03:30:00Z'),
  /** Fri Oct 30 2026, 21:00 in Los Angeles (PDT). UTC is already Saturday. */
  fridayNightLosAngeles: new Date('2026-10-31T04:00:00Z'),
  /** Thu Nov 12 2026, 11:00 in Toronto (EST). Tuesday is Nov 17. */
  thursdayMorningToronto: new Date('2026-11-12T16:00:00Z'),
};

const TORONTO = 'America/Toronto';
const LOS_ANGELES = 'America/Los_Angeles';
const MEMBERS = ['Priya', 'Maya', 'Luis'];

export const CARPOOL_READING_FIXTURES = [
  {
    id: 'tomorrow-saturday-friday-night',
    input: {
      text: "I'll drive the kids to soccer tomorrow Saturday 8am",
      senderName: 'Priya',
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.fridayNightToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['driver_claim'],
      driverName: ['Priya'],
      driverIsSender: true,
      pickupDate: '2026-10-31',
      pickupTime: '08:00',
      pickupAt: '2026-10-31T12:00:00.000Z',
    },
  },
  {
    id: 'tomorrow-saturday-chinese',
    input: {
      text: '明天周六早上8点我来开车送孩子去足球',
      senderName: 'Priya',
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.fridayNightToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['driver_claim'],
      driverName: ['Priya'],
      driverIsSender: true,
      pickupDate: '2026-10-31',
      pickupTime: '08:00',
      pickupAt: '2026-10-31T12:00:00.000Z',
    },
  },
  {
    id: 'tomorrow-saturday-disagree',
    input: {
      text: 'Soccer carpool tomorrow Saturday 8am, who can drive?',
      senderName: 'Priya',
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.sundayNightToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['plan_needs_driver'],
      driverName: null,
      pickupDate: null,
      pickupTime: '08:00',
      pickupAt: null,
    },
  },
  {
    id: 'sunday-after-fall-back',
    input: {
      text: 'Pickup for the game is Sunday 8am now, can someone drive?',
      senderName: 'Luis',
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.fridayNightToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['plan_needs_driver'],
      driverName: null,
      pickupDate: '2026-11-01',
      pickupTime: '08:00',
      pickupAt: '2026-11-01T13:00:00.000Z',
    },
  },
  {
    id: 'us-family-saturday',
    input: {
      text: 'I can take the kids to swim Saturday 9am',
      senderName: 'Luis',
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.fridayNightLosAngeles,
      timeZone: LOS_ANGELES,
      recent: [],
    },
    expect: {
      intent: ['driver_claim'],
      driverName: ['Luis'],
      driverIsSender: true,
      pickupDate: '2026-10-31',
      pickupTime: '09:00',
      pickupAt: '2026-10-31T16:00:00.000Z',
    },
  },
  {
    id: 'driver-swap',
    input: {
      text: "Maya can't make it, I'll take Saturday soccer instead",
      senderName: 'Priya',
      currentDriver: 'Maya',
      now: CARPOOL_EVAL_CLOCKS.fridayNightToronto,
      timeZone: TORONTO,
      recent: [{ from: 'member', text: "I'll drive Saturday soccer" }],
    },
    expect: {
      intent: ['driver_swap'],
      driverName: ['Priya'],
      driverIsSender: true,
      pickupDate: '2026-10-31',
      pickupAt: null,
    },
  },
  {
    id: 'cancelled',
    input: {
      text: 'Soccer is cancelled tomorrow, the field is flooded',
      senderName: 'Luis',
      currentDriver: 'Maya',
      now: CARPOOL_EVAL_CLOCKS.fridayNightToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['cancel'],
      driverName: null,
      pickupDate: '2026-10-31',
      pickupAt: null,
    },
  },
  // VIL-689 · a chat several families share. The reader sees the chat text only; the
  // runtime's `keepWhatTheChatSaid` then keeps only what a chat line says (`kept`).
  {
    id: 'shared-other-family-claims',
    shared: true,
    input: {
      text: "I'll drive soccer Tuesday at 5:30, taking Mia and Leo",
      senderName: 'Bao',
      memberNames: ['Ada', 'Bao'],
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.thursdayMorningToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['driver_claim'],
      driverName: ['Bao'],
      driverIsSender: true,
      pickupDate: '2026-11-17',
      pickupTime: '17:30',
      pickupAt: '2026-11-17T22:30:00.000Z',
      kept: { kids: 'Mia and Leo' },
    },
  },
  {
    id: 'shared-names-another-driver',
    shared: true,
    input: {
      text: 'Ada is driving soccer Tuesday at 5:30',
      senderName: 'Bao',
      memberNames: ['Ada', 'Bao'],
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.thursdayMorningToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['driver_claim'],
      driverName: ['Ada'],
      driverIsSender: false,
      pickupDate: '2026-11-17',
      pickupTime: '17:30',
      pickupAt: '2026-11-17T22:30:00.000Z',
      kept: { driverName: 'Ada', kids: null },
    },
  },
  {
    id: 'shared-needs-driver',
    shared: true,
    input: {
      text: 'can anyone drive the kids to soccer Tuesday 5:30?',
      senderName: 'Ada',
      memberNames: ['Ada', 'Bao'],
      currentDriver: null,
      now: CARPOOL_EVAL_CLOCKS.thursdayMorningToronto,
      timeZone: TORONTO,
      recent: [],
    },
    expect: {
      intent: ['plan_needs_driver'],
      driverName: null,
      pickupDate: '2026-11-17',
      pickupTime: '17:30',
      pickupAt: '2026-11-17T22:30:00.000Z',
      kept: { driverName: null },
    },
  },
].map((fixture) => ({
  ...fixture,
  input: { memberNames: MEMBERS, ...fixture.input },
}));

const fold = (value) => value.normalize('NFKC').trim().toLowerCase();

/**
 * Why this reading is wrong for this fixture; empty when it is right.
 * `pickupAt` is the ISO instant the runtime resolved from the reading, or null.
 */
export function gradeCarpoolReading(expect, { reading, pickupAt }) {
  const failures = [];
  if (!expect.intent.includes(reading.intent)) failures.push(`intent=${reading.intent}`);
  const driverOk =
    expect.driverName === null
      ? reading.driverName === null
      : reading.driverName !== null &&
        expect.driverName.some((name) => fold(name) === fold(reading.driverName));
  if (!driverOk) failures.push(`driverName=${JSON.stringify(reading.driverName)}`);
  if (expect.driverIsSender !== undefined && reading.driverIsSender !== expect.driverIsSender) {
    failures.push(`driverIsSender=${reading.driverIsSender}`);
  }
  if (reading.pickupDate !== expect.pickupDate) {
    failures.push(`pickupDate=${JSON.stringify(reading.pickupDate)}`);
  }
  if (expect.pickupTime !== undefined && reading.pickupTime !== expect.pickupTime) {
    failures.push(`pickupTime=${JSON.stringify(reading.pickupTime)}`);
  }
  if (pickupAt !== expect.pickupAt) failures.push(`pickupAt=${pickupAt}`);
  return failures;
}

/**
 * VIL-689 · what the runtime keeps of a shared chat's reading (`keepWhatTheChatSaid`,
 * passed in as `kept`, null when no ride is recorded), against `expect.kept`: each named
 * field must equal what was kept. Nothing the chat did not say may survive.
 */
export function gradeSharedKept(expect, kept) {
  if (!expect.kept) return [];
  if (kept === null) return ['kept=null (no ride recorded)'];
  const failures = [];
  for (const [field, want] of Object.entries(expect.kept)) {
    const got = kept[field] ?? null;
    const same =
      want === null ? got === null : got !== null && fold(String(got)) === fold(String(want));
    if (!same) failures.push(`kept.${field}=${JSON.stringify(got)}`);
  }
  return failures;
}
