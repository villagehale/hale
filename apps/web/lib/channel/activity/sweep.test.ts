import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import type { DueCommitment } from '~/lib/commitments/ledger';
import type { DeepSlot } from './deep';
import type { ActivityPick } from './lane';
import type { ActivityFollowUpDeps } from './sweep';
import { runActivityFollowUpSweep } from './sweep';

/**
 * THE SWEEP THAT MAKES "I'LL COME BACK TO YOU" TRUE.
 *
 * The one property this file exists for: THE EMPTY-HANDED PROMISE IS STILL KEPT. A sweep
 * that texted only on a good result would silently drop every disappointing promise —
 * a worse version of the defect the whole feature answers, because the parent would be
 * waiting on something Hale had decided not to send. So the bad-news path is asserted as
 * hard as the good-news one, and both close the ledger row.
 *
 * The composer's words are the eval's job (rule #8); what is here is what happens around
 * them.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const NOW = new Date('2026-08-21T14:00:00.000Z');

const DUE: DueCommitment = {
  id: 'commitment-1',
  familyId: FAMILY,
  topic: 'toddler gymnastics this fall',
  summary: 'A promise to come back with what I find on toddler gymnastics this fall',
  createdFrom: 'msg-9',
  subjectChildId: null,
  dueAt: new Date('2026-08-21T13:00:00.000Z'),
};

const PICK: ActivityPick = {
  name: 'Halton Hills Gymnastics',
  ageFit: '18 months - 3 years',
  when: 'Saturdays 9:15am from Sept 13',
  price: '$142',
  sourceName: 'Halton Hills Gymnastics Centre',
  source: 'web',
};

const SHARE_URL = 'https://app.villagehale.com/a/tok3n';

const database = {} as Database;

afterEach(() => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[F14_ALLOWLIST_ENV];
  vi.restoreAllMocks();
});

interface Harness {
  deps: ActivityFollowUpDeps;
  transport: FakeTransport;
  fulfilled: unknown[];
  cancelled: unknown[];
  threaded: string[];
  audited: unknown[];
  composed: unknown[];
  shared: unknown[];
}

function harness(
  overrides: {
    due?: DueCommitment[];
    hold?: ProactiveHoldReason;
    find?: Awaited<ReturnType<ActivityFollowUpDeps['finder']['find']>>;
    compose?: Awaited<ReturnType<ActivityFollowUpDeps['composer']['compose']>>;
    householdNames?: string[];
    deep?: Awaited<ReturnType<ActivityFollowUpDeps['deep']['research']>>;
    sharePage?: Awaited<ReturnType<ActivityFollowUpDeps['sharePage']>>;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const fulfilled: unknown[] = [];
  const cancelled: unknown[] = [];
  const threaded: string[] = [];
  const audited: unknown[] = [];
  const composed: unknown[] = [];
  const shared: unknown[] = [];

  const deps: ActivityFollowUpDeps = {
    loadDue: async () => overrides.due ?? [DUE],
    resolveRecipient: async () => ({ parentUserId: PARENT, conversationId: 'conv-1' }),
    reader: {
      municipality: async () => 'halton_hills',
      stage: async () => 'toddler',
      householdNames: async () => overrides.householdNames ?? ['Noah'],
    },
    finder: {
      async find() {
        return overrides.find ?? { found: true, picks: [PICK] };
      },
    },
    // Unavailable by default so every pre-existing case still exercises the SHALLOW path
    // it was written against; the deep cases opt in.
    deep: {
      async research() {
        return overrides.deep ?? { status: 'unavailable', reason: 'client_unavailable' };
      },
    },
    sharePage: async (_db, input) => {
      shared.push(input);
      return overrides.sharePage ?? { status: 'minted', url: SHARE_URL, slots: input.slots.length };
    },
    composer: {
      async compose(grounding) {
        composed.push(grounding);
        return overrides.compose ?? { status: 'composed', message: `${PICK.name} runs Saturdays.` };
      },
    },
    buildGate: () => ({
      channelEnrolled: async () => overrides.hold !== 'not_enrolled',
      watchConsentGranted: async () => overrides.hold !== 'no_watch_consent',
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      parentTimeZone: async () => (overrides.hold === 'quiet_hours' ? 'Pacific/Kiritimati' : 'UTC'),
    }),
    dedupeActive: async () => false,
    resolveSendablePhone: async () => '+14165550100',
    transport,
    recordSend: async () => 'msg-out-1',
    audit: async (_db, row) => {
      audited.push(row);
    },
    appendMessage: (async (_conversationId: string, _role: string, body: string) => {
      threaded.push(body);
    }) as unknown as ActivityFollowUpDeps['appendMessage'],
    fulfillCommitment: (async (_db: Database, input: unknown) => {
      fulfilled.push(input);
      return { status: 'closed' as const, commitmentIds: ['commitment-1'] };
    }) as unknown as ActivityFollowUpDeps['fulfillCommitment'],
    cancelPromise: (async (_db: Database, input: unknown) => {
      cancelled.push(input);
      return { status: 'closed' as const, commitmentIds: ['commitment-1'] };
    }) as unknown as ActivityFollowUpDeps['cancelPromise'],
  };
  return { deps, transport, fulfilled, cancelled, threaded, audited, composed, shared };
}

function armed() {
  process.env[F14_ENABLED_ENV] = 'true';
}

describe('the dark-launch gate', () => {
  it('does not even select families when the flag is off', async () => {
    const h = harness();
    expect(await runActivityFollowUpSweep(database, h.deps, NOW)).toMatchObject({
      enabled: false,
      due: 0,
    });
    expect(h.transport.bodies()).toEqual([]);
  });
});

describe('a promise with finds', () => {
  it('sends them and closes the row against the message that carried them', async () => {
    armed();
    const h = harness();

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ due: 1, sent: 1, sentEmptyHanded: 0, deferred: 0, failed: 0 });
    expect(h.transport.bodies()[0]).toContain(PICK.name);
    expect(h.fulfilled).toEqual([
      { familyId: FAMILY, kind: 'activity_followup', channelMessageId: 'msg-out-1', now: NOW },
    ]);
    // Threaded, so the parent's reply arrives as an ordinary coach turn with the finds in
    // front of it — and the CASL line stays on the wire, out of the history.
    expect(h.threaded).toEqual([`${PICK.name} runs Saturdays.`]);
    // The audit row counts the finds and never names them (rule #1).
    expect(h.audited[0]).toMatchObject({
      actionTaken: 'activity_followup_sent',
      after: { picks: 1 },
    });
    expect(JSON.stringify(h.audited)).not.toContain(PICK.name);
  });

  it('re-runs the search on the stored subject, with the town and band read fresh', async () => {
    armed();
    const h = harness();
    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ subject: 'toddler gymnastics this fall' });
  });
});

describe('the promise is kept when the news is bad', () => {
  it('sends the empty-handed message and STILL closes the row', async () => {
    armed();
    const h = harness({
      find: { found: false, reason: 'no_picks' },
      compose: {
        status: 'composed',
        message: 'I went back through the fall listings - nothing yet.',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, sentEmptyHanded: 1, deferred: 0 });
    expect(h.transport.bodies()[0]).toContain('nothing yet');
    // KEPT, not voided: the promise was to come back, and coming back empty-handed and
    // saying so is keeping it.
    expect(h.fulfilled).toHaveLength(1);
    expect(h.cancelled).toEqual([]);
    // The composer was asked for the empty shape rather than being skipped.
    expect(h.composed[0]).toMatchObject({ picks: [] });
  });
});

describe('what leaves the promise open, and what closes it without a word', () => {
  it('holds on quiet hours and sends nothing, leaving the row open', async () => {
    armed();
    const h = harness({ hold: 'quiet_hours' });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.held.quiet_hours).toBe(1);
    expect(result.sent).toBe(0);
    expect(h.transport.bodies()).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it('does NOT search when it is going to be held - a held family costs no web spend', async () => {
    armed();
    let searches = 0;
    const h = harness({ hold: 'quiet_hours' });
    h.deps.finder = {
      async find() {
        searches += 1;
        return { found: true, picks: [PICK] };
      },
    };

    await runActivityFollowUpSweep(database, h.deps, NOW);
    expect(searches).toBe(0);
  });

  it('VOIDS the promise when the family can no longer be texted at all', async () => {
    armed();
    const h = harness({ hold: 'not_enrolled' });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.cancelled).toBe(1);
    expect(h.cancelled).toEqual([{ familyId: FAMILY, now: NOW }]);
    expect(h.fulfilled).toEqual([]);
  });

  it('leaves the row open when the search itself could not run', async () => {
    armed();
    const restore = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ find: { found: false, reason: 'ground_failed' } });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    // An outage is not news. Nothing is sent and nothing is closed — the difference
    // between "there is nothing on" and "I could not look".
    expect(result).toMatchObject({ deferred: 1, sent: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    restore.mockRestore();
  });

  it('leaves the row open when nothing sendable composed - never a canned line', async () => {
    armed();
    const restore = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      compose: { status: 'deferred', reason: 'gates_exhausted', violations: ['too long'] },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ deferred: 1, sent: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    restore.mockRestore();
  });

  it('refuses to search a stored subject that no longer clears de-identification', async () => {
    armed();
    const restore = vi.spyOn(console, 'error').mockImplementation(() => {});
    let searches = 0;
    // A child added since the promise was made, whose name is in the stored subject.
    const h = harness({
      due: [{ ...DUE, topic: 'gymnastics for Rowan' }],
      householdNames: ['Noah', 'Rowan'],
    });
    h.deps.finder = {
      async find() {
        searches += 1;
        return { found: true, picks: [PICK] };
      },
    };

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ unsendable: 1, sent: 0 });
    expect(searches).toBe(0);
    restore.mockRestore();
  });

  it('POSITIVE CONTROL - the same subject searches fine before that child exists', async () => {
    armed();
    const h = harness({
      due: [{ ...DUE, topic: 'gymnastics for Rowan' }],
      householdNames: ['Noah'],
    });

    expect(await runActivityFollowUpSweep(database, h.deps, NOW)).toMatchObject({ sent: 1 });
  });
});

describe("the founder's owed Cartwheels row, paid by the deep pass", () => {
  /**
   * THE ROW THIS ARC OWES.
   *
   * 2026-08-21 16:14 UTC, family a0fa6932: an `activity_followup` promise with topic
   * "Cartwheels" is open on the ledger. On the turn that made it Hale said "no dates or
   * price up yet". The published fall block — Sept 14/15 to Oct 26/27, $124-145,
   * registration open since July 22 — was sitting on cartwheelsgymcentre.com's own
   * schedule page the whole time, in a "schedule at a glance" grid the search snippet
   * never carried (verified by hand against the live page while building this).
   *
   * This is that row, in the shapes the code will actually see, run end to end through the
   * real sweep. The venue fixture is deliberately built the way the page is: several dated
   * slots, a price on each, one registration fact, every row citing the page it came off.
   */
  const CARTWHEELS_DUE: DueCommitment = {
    id: 'commitment-cartwheels',
    familyId: 'a0fa6932',
    topic: 'Cartwheels',
    summary: 'A promise to come back with what I find on Cartwheels',
    createdFrom: 'msg-cartwheels',
    subjectChildId: null,
    dueAt: new Date('2026-08-21T16:14:00.000Z'),
  };

  const PAGE = 'https://www.cartwheelsgymcentre.com/programs.php';

  function slot(name: string, when: string, price: string): DeepSlot {
    return {
      name: `${name}, Cartwheels Gym Centre`,
      ageFit: 'walking to 3.5 years, with a parent',
      when,
      price,
      registration: 'Registration has been open since July 22',
      sourceName: 'Cartwheels Gym Centre',
      sourceUrl: PAGE,
      source: 'web',
    };
  }

  const SLOTS: DeepSlot[] = [
    slot('Tiny Gym', 'Sundays 9:30-10:15, Sept 14 to Oct 26', '$124 per term'),
    slot('Tiny Gym', 'Mondays 9:15-10:00, Sept 15 to Oct 27', '$145 per term'),
    slot('Mini Gym', 'Mondays 10:15-11:00, Sept 15 to Oct 27', '$145 per term'),
    slot('Tumble n Learn', 'Tuesdays 9:30-11:30, Sept 16 to Oct 28', '$145 per term'),
  ];

  function payable(overrides: Parameters<typeof harness>[0] = {}) {
    return harness({
      due: [CARTWHEELS_DUE],
      deep: { status: 'read', slots: SLOTS, pagesRead: 2, pagesRefused: 1 },
      ...overrides,
    });
  }

  it('sends a text carrying a dated slot, a price and the registration fact', async () => {
    armed();
    // The composer is the eval's job (rule #8), so it is asked here for the sentence it
    // would write from these slots — what this asserts is that the sweep put the facts in
    // front of it and put its sentence on the wire.
    const h = payable({
      compose: {
        status: 'composed',
        message:
          'Cartwheels has Tiny Gym Sundays 9:30-10:15 from Sept 14, $124 a term - their site says, and registration has been open since July 22. Want me to hold you a spot?',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.sent).toBe(1);
    expect(result.deepRead).toBe(1);
    expect(result.sentEmptyHanded).toBe(0);

    const sent = h.transport.sent[0]?.body ?? '';
    expect(sent).toContain('Sept 14');
    expect(sent).toContain('$124');
    expect(sent).toContain('July 22');
    // And the promise is closed against the message that closed it.
    expect(h.fulfilled).toEqual([
      { familyId: 'a0fa6932', kind: 'activity_followup', channelMessageId: 'msg-out-1', now: NOW },
    ]);
  });

  it('grounds the composer on the best TWO slots and puts the other two on a page', async () => {
    armed();
    const h = payable();

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    // The text is written about two; the share page is offered all four.
    expect((h.composed[0] as { picks: unknown[] }).picks).toHaveLength(2);
    expect((h.shared[0] as { slots: unknown[] }).slots).toHaveLength(4);
    expect(result.shared).toBe(1);
    expect(h.transport.sent[0]?.body).toContain(SHARE_URL);
  });

  it('threads the message the parent actually got - link and all', async () => {
    armed();
    const h = payable();

    await runActivityFollowUpSweep(database, h.deps, NOW);

    // The CASL tail belongs on the wire and nowhere else; the link is part of the answer.
    expect(h.threaded[0]).toContain(SHARE_URL);
    expect(h.threaded[0]).not.toContain('STOP');
  });

  it('mints no page when everything found already fits in the text', async () => {
    armed();
    const h = harness({
      due: [CARTWHEELS_DUE],
      deep: { status: 'read', slots: SLOTS.slice(0, 2), pagesRead: 1, pagesRefused: 0 },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.shared).toEqual([]);
    expect(result.shared).toBe(0);
    expect(h.transport.sent[0]?.body).not.toContain('/a/');
  });

  it('still sends when the share page could not be written', async () => {
    armed();
    const h = payable({ sharePage: { status: 'skipped', reason: 'write_failed' } });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.sent).toBe(1);
    expect(result.shared).toBe(0);
    expect(h.transport.sent[0]?.body).not.toContain('/a/');
  });

  it('THE DEFECT: a deep pass that opened NO page falls back rather than claiming nothing is posted', async () => {
    armed();
    const h = harness({
      due: [CARTWHEELS_DUE],
      deep: { status: 'unread', pagesRefused: 3 },
      find: { found: true, picks: [PICK] },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.deepUnread).toBe(1);
    expect(result.deepRead).toBe(0);
    // The shallow search still ran and the parent still hears back — what did NOT happen
    // is a message written from an empty slot list, which would have said the pages carry
    // nothing about pages nobody opened.
    expect(result.sent).toBe(1);
    expect((h.composed[0] as { picks: unknown[] }).picks).toEqual([PICK]);
  });

  it('an opened page that genuinely has nothing still comes back, empty-handed and honest', async () => {
    armed();
    const h = harness({
      due: [CARTWHEELS_DUE],
      deep: { status: 'read', slots: [], pagesRead: 2, pagesRefused: 0 },
      compose: { status: 'composed', message: 'I read their fall page and there is nothing up.' },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.sent).toBe(1);
    expect(result.sentEmptyHanded).toBe(1);
    expect(result.deepRead).toBe(1);
    // Kept, not cancelled — the promise was to come back, not to succeed.
    expect(h.fulfilled).toHaveLength(1);
  });

  it('bounds the expensive instrument at two per tick and keeps every other promise anyway', async () => {
    armed();
    const due = [1, 2, 3, 4].map((n) => ({
      ...CARTWHEELS_DUE,
      id: `c-${n}`,
      familyId: `fam-${n}`,
    }));
    const h = harness({
      due,
      deep: { status: 'read', slots: SLOTS, pagesRead: 2, pagesRefused: 0 },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.deepRead).toBe(2);
    expect(result.sent).toBe(4);
  });
});
