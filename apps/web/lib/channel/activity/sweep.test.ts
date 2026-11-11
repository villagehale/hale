import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import type { DueCommitment } from '~/lib/commitments/ledger';
import type { WatchCalendarOutcome } from './calendar-check';
import { ACTIVITY_WATCH_DUE_HOURS } from './commitment';
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
  heardFacts: null,
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
  heldNotes: string[];
  watched: unknown[];
  deferredWatches: unknown[];
  calendarChecks: unknown[];
  closedWatches: unknown[];
}

function harness(
  overrides: {
    due?: DueCommitment[];
    hold?: ProactiveHoldReason;
    find?: Awaited<ReturnType<ActivityFollowUpDeps['finder']['find']>>;
    compose?: Awaited<ReturnType<ActivityFollowUpDeps['composer']['compose']>>;
    householdNames?: string[];
    deep?: Awaited<ReturnType<ActivityFollowUpDeps['deep']['research']>>;
    recordWatch?: Awaited<ReturnType<ActivityFollowUpDeps['recordWatch']>>;
    /** What the reconciliation gate says about the wire body (VIL-293). Empty is the
     * ordinary answer: nothing in an activity follow-up claims a row by default. */
    unbacked?: Awaited<ReturnType<ActivityFollowUpDeps['refuseUnbackedSend']>>;
    /** The thread the promise's own message carried, or null when it carried none. */
    conversationId?: string | null;
    /** `users.locale` for the parent the promise was sent to. */
    language?: string;
    /** What the calendar check answers for a watch. Empty calendar by default. */
    calendar?: WatchCalendarOutcome;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const fulfilled: unknown[] = [];
  const cancelled: unknown[] = [];
  const threaded: string[] = [];
  const audited: unknown[] = [];
  const composed: unknown[] = [];
  const heldNotes: string[] = [];
  const watched: unknown[] = [];
  const deferredWatches: unknown[] = [];
  const calendarChecks: unknown[] = [];
  const closedWatches: unknown[] = [];

  const deps: ActivityFollowUpDeps = {
    refuseUnbackedSend: async () => overrides.unbacked ?? [],
    loadDue: async () => overrides.due ?? [DUE],
    resolveRecipient: async () => ({
      parentUserId: PARENT,
      conversationId: overrides.conversationId === undefined ? 'conv-1' : overrides.conversationId,
      language: overrides.language ?? 'en-CA',
    }),
    reader: {
      place: async () => ({ status: 'known', town: 'Halton Hills' }),
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
    composer: {
      async compose(grounding) {
        composed.push(grounding);
        return (
          overrides.compose ?? {
            status: 'composed',
            message: `${PICK.name} runs Saturdays.`,
            mentionsWatch: false,
          }
        );
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
    threadMessage: (async (_db: Database, input: { body: string; topic?: string | null }) => {
      if (input.topic === 'activity_held') heldNotes.push(input.body);
      else threaded.push(input.body);
      return 'conv-1';
    }) as unknown as ActivityFollowUpDeps['threadMessage'],
    fulfillCommitment: (async (_db: Database, input: unknown) => {
      fulfilled.push(input);
      return { status: 'closed' as const, commitmentIds: ['commitment-1'] };
    }) as unknown as ActivityFollowUpDeps['fulfillCommitment'],
    cancelPromise: (async (_db: Database, input: unknown) => {
      cancelled.push(input);
      return { status: 'closed' as const, commitmentIds: ['commitment-1'] };
    }) as unknown as ActivityFollowUpDeps['cancelPromise'],
    recordWatch: async (_db, input) => {
      watched.push(input);
      return overrides.recordWatch ?? { status: 'recorded', commitmentId: 'commitment-2' };
    },
    deferWatch: async (_db, input) => {
      deferredWatches.push(input);
      return { status: 'deferred' };
    },
    calendarCheck: {
      async check(_db, watch) {
        calendarChecks.push(watch);
        return overrides.calendar ?? { outcome: 'calendar_empty' };
      },
    },
    closeWatch: async (_db, input) => {
      closedWatches.push(input);
      return { status: 'closed', commitmentIds: [input.commitmentId] };
    },
  };
  return {
    deps,
    transport,
    fulfilled,
    cancelled,
    threaded,
    audited,
    composed,
    heldNotes,
    watched,
    deferredWatches,
    calendarChecks,
    closedWatches,
  };
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
    // front of it. The opt-out line is not on the wire.
    expect(h.threaded).toEqual([`${PICK.name} runs Saturdays.`]);
    // The audit row counts the finds and never names them (rule #1).
    expect(h.audited[0]).toMatchObject({
      actionTaken: 'activity_followup_sent',
      after: { picks: 1 },
    });
    expect(h.watched).toEqual([]);
    expect(JSON.stringify(h.audited)).not.toContain(PICK.name);
  });

  it('threads the follow-up even when the promise carried no thread of its own', async () => {
    // The thread was resolved off `channel_messages.related_conversation_id` of the
    // message that OPENED the promise — and every proactive sender leaves that column
    // null. So the one class of family this follow-up exists for, the one whose promise
    // came out of a nudge rather than a coach turn, was the one it never threaded for.
    // The anchor is derivable from the family and parent ids, so there is nothing here
    // that can be absent (lib/channel/thread.ts).
    armed();
    const h = harness({ conversationId: null });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1 });
    expect(h.threaded).toEqual([`${PICK.name} runs Saturdays.`]);
  });

  it('re-runs the search on the stored subject, with the town and band read fresh', async () => {
    armed();
    const h = harness();
    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({
      subject: 'toddler gymnastics this fall',
      language: 'en-CA',
    });
  });

  it('hands the composer the language tag stored for this parent', async () => {
    armed();
    const h = harness({ language: 'zh' });
    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ language: 'zh' });
    const ar = harness({ language: 'ar' });
    await runActivityFollowUpSweep(database, ar.deps, NOW);
    expect(ar.composed[0]).toMatchObject({ language: 'ar' });
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
        mentionsWatch: false,
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
    heardFacts: null,
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
      deep: {
        status: 'read',
        slots: SLOTS,
        searchResults: 8,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 1,
        pageVerdict: 'page_has_schedule',
      },
      ...overrides,
    });
  }

  it('sends a text carrying a dated slot, a price and the registration fact', async () => {
    armed();
    // The composer is the eval's job (rule #8), so it is asked here for the sentence it
    // would write from these slots — what this asserts is that the sweep put the facts in
    // front of it and put its sentence on the wire. It ENDS ON A STATEMENT because the
    // real composer's gates refuse anything else, and a fake that asks a question is a
    // fake of a message this lane cannot produce.
    const h = payable({
      compose: {
        status: 'composed',
        message:
          'Cartwheels has Tiny Gym Sundays 9:30-10:15 from Sept 14, $124 a term - their site says, and registration has been open since July 22.',
        mentionsWatch: false,
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

  it('grounds the composer on the best TWO slots and holds the other two for the chat', async () => {
    armed();
    const h = payable();

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.sent).toBe(1);
    const composed = h.composed[0] as { picks: { name: string }[]; moreRemaining: number };
    expect(composed.picks).toHaveLength(2);
    expect(composed.moreRemaining).toBe(2);
    expect(h.transport.sent[0]?.body).toContain(PAGE);
    expect(h.transport.sent[0]?.body).not.toContain('villagehale.com');
    const held = JSON.parse(h.heldNotes[0] ?? '{}') as {
      unsent_activity_options: { name: string; source_url: string }[];
    };
    expect(held.unsent_activity_options.map((option) => option.name)).toEqual([
      'Mini Gym, Cartwheels Gym Centre',
      'Tumble n Learn, Cartwheels Gym Centre',
    ]);
    expect(held.unsent_activity_options.every((option) => option.source_url === PAGE)).toBe(true);
  });

  it('carries the registration row into the text when the extract put it past the cut', async () => {
    armed();
    const undated = SLOTS.map((row) => ({ ...row, registration: null }));
    const registrationRow: DeepSlot = {
      ...SLOTS[0]!,
      name: 'Fall registration (covers Tiny Gym), Cartwheels Gym Centre',
      when: null,
      price: null,
    };
    const h = payable({
      deep: {
        status: 'read',
        slots: [undated[0]!, undated[1]!, undated[2]!, registrationRow],
        searchResults: 8,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 1,
        pageVerdict: 'page_has_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    const composed = h.composed[0] as { picks: { name: string }[] };
    expect(composed.picks.map((pick) => pick.name)).toEqual([
      undated[0]!.name,
      undated[1]!.name,
      registrationRow.name,
    ]);
  });

  it('threads the message the parent actually got - venue page and all', async () => {
    armed();
    const h = payable();

    await runActivityFollowUpSweep(database, h.deps, NOW);

    // The venue page is part of the answer. The opt-out line is not. The held note is
    // a second thread row, not the sentence the parent was sent.
    expect(h.threaded[0]).toContain(PAGE);
    expect(h.threaded[0]).not.toContain('STOP');
    expect(h.threaded).toHaveLength(1);
    expect(h.heldNotes).toHaveLength(1);
  });

  it('holds nothing when everything found already fits in the text, and still links the venue', async () => {
    armed();
    const h = harness({
      due: [CARTWHEELS_DUE],
      deep: {
        status: 'read',
        slots: SLOTS.slice(0, 2),
        searchResults: 8,
        pagesRead: 1,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.heldNotes).toEqual([]);
    expect((h.composed[0] as { moreRemaining: number }).moreRemaining).toBe(0);
    expect(h.transport.sent[0]?.body).toContain(PAGE);
    expect(h.transport.sent[0]?.body).not.toContain('villagehale.com');
  });

  it('THE DEFECT: a deep pass that opened NO page falls back rather than claiming nothing is posted', async () => {
    armed();
    const h = harness({
      due: [CARTWHEELS_DUE],
      deep: { status: 'unread', searchResults: 5, pagesRefused: 3 },
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
      deep: {
        status: 'read',
        slots: [],
        searchResults: 8,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
      compose: {
        status: 'composed',
        message: 'I read their fall page and there is nothing up.',
        mentionsWatch: false,
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result.sent).toBe(1);
    expect(result.sentEmptyHanded).toBe(1);
    expect(result.deepRead).toBe(1);
    // Kept, not cancelled — the promise was to come back, not to succeed.
    expect(h.fulfilled).toHaveLength(1);
  });

  it('bounds the expensive instrument at ONE per tick and keeps every other promise anyway', async () => {
    armed();
    const due = [1, 2, 3, 4].map((n) => ({
      ...CARTWHEELS_DUE,
      id: `c-${n}`,
      familyId: `fam-${n}`,
    }));
    const h = harness({
      due,
      deep: {
        status: 'read',
        slots: SLOTS,
        searchResults: 8,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    // One streamed research turn is ~100s of a 300-second function this sweep enters
    // last (see MAX_DEEP_PER_RUN). Every other promise still gets the shallow answer.
    expect(result.deepRead).toBe(1);
    expect(result.sent).toBe(4);
  });
});

/**
 * D1 — THE OFFER IS A PROPOSAL, THROUGH THE SECOND DOOR.
 *
 * 2026-08-22, 17:19 UTC, production. The sweep kept its promise, marked the commitment
 * `fulfilled`, and sent: "...but fall days, times and prices aren't posted yet. Want me
 * to check back once they're up?" No row was written for that question. Twenty minutes
 * later the parent said "Yes, please", the approvals grammar claimed it because nothing
 * else was open, and they were handed a menu of two unrelated drafted actions.
 *
 * The fix is a subtraction of the QUESTION, not an addition of a handler: when the answer
 * leaves something open, the sweep registers the continuation itself and the message says
 * what Hale is already doing. There is nothing left for a parent to say yes to.
 */
describe('a partial answer registers the watch it talks about', () => {
  const PARTIAL: DeepSlot = {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years, with a parent',
    when: null,
    price: null,
    registration: null,
    sourceName: 'Cartwheels Gym Centre',
    sourceUrl: 'https://cartwheelsgymcentre.com/programs.php',
    source: 'web',
  };

  function partialHarness(overrides: Parameters<typeof harness>[0] = {}) {
    return harness({
      deep: {
        status: 'read',
        slots: [PARTIAL],
        searchResults: 6,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 1,
        pageVerdict: 'page_has_schedule',
      },
      compose: {
        status: 'composed',
        message: "Cartwheels runs Tiny Gym for under-3s - their site says. I'll keep watching.",
        mentionsWatch: true,
      },
      ...overrides,
    });
  }

  it('THE DEFECT: a find with no day and no price mints a continuation promise', async () => {
    armed();
    const h = partialHarness();

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, watching: 1, watchUnrecorded: 0 });
    // Against the message that carried the sentence, on the same de-identified subject,
    // due a week out — so the next tick re-runs the same search.
    expect(h.watched).toEqual([
      {
        familyId: FAMILY,
        promise: { subject: 'toddler gymnastics this fall', childId: null },
        channelMessageId: 'msg-out-1',
        dueInHours: ACTIVITY_WATCH_DUE_HOURS,
        // The parent was told no day, no time and no price, so a later look that finds
        // none either has nothing to say.
        heardFacts: [],
        now: NOW,
      },
    ]);
  });

  it('closes the OLD promise before opening the new one - the index permits one', async () => {
    armed();
    const h = partialHarness();
    const order: string[] = [];
    const deps = {
      ...h.deps,
      fulfillCommitment: (async () => {
        order.push('fulfill');
        return { status: 'closed' as const, commitmentIds: ['commitment-1'] };
      }) as unknown as ActivityFollowUpDeps['fulfillCommitment'],
      recordWatch: async () => {
        order.push('watch');
        return { status: 'recorded' as const, commitmentId: 'commitment-2' };
      },
    };

    await runActivityFollowUpSweep(database, deps, NOW);

    expect(order).toEqual(['fulfill', 'watch']);
  });

  it('tells the composer it is watching, so the copy STATES it instead of asking', async () => {
    armed();
    const h = partialHarness();

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ watch: true, pageEvidence: 'page_has_schedule' });
  });

  it('THE LIVE SHAPE: a when/price that explains its own absence is still a gap', async () => {
    // Live, 2026-08-22, on the venue this whole arc is named after: the extract filled
    // `price` with "Not listed on main site; pricing varies by term length and is only
    // visible after logging into the Registration Website" instead of leaving it out. A
    // null check alone read that as a fact and minted no watch.
    armed();
    const h = partialHarness({
      deep: {
        status: 'read',
        slots: [
          {
            ...PARTIAL,
            when: 'Fall Term 1 2026-27 - exact weekday and time not listed on the Programs page',
            price: 'Not listed on main site; only visible after logging in to register',
          },
        ],
        searchResults: 19,
        pagesRead: 4,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ watching: 1 });
    expect(h.composed[0]).toMatchObject({ watch: true });
  });

  it('POSITIVE CONTROL - a complete find registers nothing and claims nothing', async () => {
    armed();
    const h = harness({
      deep: {
        status: 'read',
        slots: [{ ...PARTIAL, when: 'Sundays 9:30', price: '$124 per term' }],
        searchResults: 6,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, watching: 0, watchUnrecorded: 0 });
    expect(h.watched).toEqual([]);
    expect(h.composed[0]).toMatchObject({ watch: false });
  });

  it('an EMPTY-handed follow-up is a watch too - there is still nothing to hand over', async () => {
    armed();
    const h = harness({
      find: { found: false, reason: 'no_picks' },
      compose: {
        status: 'composed',
        message: "Nothing up for the fall session yet - I'll keep looking and text you.",
        mentionsWatch: true,
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sentEmptyHanded: 1, watching: 1 });
    expect(h.composed[0]).toMatchObject({ watch: true });
  });

  it('a watch row whose sent text never mentions it is logged, counts and codes only', async () => {
    armed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const silent = 'Cartwheels runs Tiny Gym for under-3s - their site says.';
    const h = partialHarness({
      compose: { status: 'composed', message: silent, mentionsWatch: false },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);
    const calls = warn.mock.calls.filter(([, msg]) => String(msg).includes('silent watch'));
    warn.mockRestore();

    expect(result).toMatchObject({ sent: 1, watching: 1 });
    expect(calls).toEqual([[{ code: 'silent_watch', picks: 1 }, expect.any(String)]]);
    expect(JSON.stringify(calls)).not.toContain('Cartwheels');
  });

  it('POSITIVE CONTROL - a watch the text tells the parent about logs nothing', async () => {
    armed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = partialHarness();

    await runActivityFollowUpSweep(database, h.deps, NOW);
    const calls = warn.mock.calls.filter(([, msg]) => String(msg).includes('silent watch'));
    warn.mockRestore();

    expect(h.watched).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('a watch the ledger refused is COUNTED, never swallowed', async () => {
    armed();
    const h = partialHarness({ recordWatch: { status: 'not_recorded', reason: 'write_failed' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);
    spy.mockRestore();

    // The parent still got their text — the send is upstream of this and must not be
    // retried — but the run says out loud that a promise is now unbacked.
    expect(result).toMatchObject({ sent: 1, watching: 0, watchUnrecorded: 1 });
  });
});

/**
 * VIL-564 — A WATCH SENDS NEWS OR NOTHING.
 *
 * One parent got "couldn't pin down the days or times, I'll keep watching" on 2026-10-20
 * and again on 2026-10-28: every watch:true follow-up minted a fresh watch, and the next
 * look sent whatever it found, compared with nothing. A continuation now carries the facts
 * its last message told the parent, and the look that follows sends only a fact they have
 * not heard — a time, a price, a date, an opening.
 */
describe('a watch sends news or nothing', () => {
  const HALF: DeepSlot = {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years, with a parent',
    when: 'Saturdays 9:15am from Sept 13',
    price: null,
    registration: null,
    sourceName: 'Cartwheels Gym Centre',
    sourceUrl: 'https://cartwheelsgymcentre.com/programs.php',
    source: 'web',
  };
  /** What the last follow-up told the parent, written from the spec rather than read back
   * off the code: the day, the clock time and the start date of `HALF.when`. */
  const HEARD_HALF = ['when:date:sep-13', 'when:day:sat', 'when:time:9:15'];
  const WEEK_LATER = new Date(NOW.getTime() + ACTIVITY_WATCH_DUE_HOURS * 3_600_000);

  function watchHarness(heardFacts: string[] | null, slots: DeepSlot[]) {
    return harness({
      due: [{ ...DUE, heardFacts }],
      deep: {
        status: 'read',
        slots,
        searchResults: 6,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
      compose: {
        status: 'composed',
        message: 'Tiny Gym runs Saturdays at 9:15 and 10:30.',
        mentionsWatch: false,
      },
    });
  }

  it('THE DEFECT: a second look that still found no day, time or price sends nothing', async () => {
    armed();
    const h = watchHarness([], [{ ...HALF, when: null }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ due: 1, sent: 0, nothingNew: 1, deferred: 0, failed: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.composed).toEqual([]);
    // Still owed, on its own clock — neither kept (nothing made good on it) nor voided.
    expect(h.fulfilled).toEqual([]);
    expect(h.cancelled).toEqual([]);
    expect(h.watched).toEqual([]);
    expect(h.deferredWatches).toEqual([
      { commitmentId: DUE.id, familyId: FAMILY, dueAt: WEEK_LATER, reason: 'nothing_new' },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ commitmentId: DUE.id, outcome: 'nothing_new' }),
      expect.any(String),
    );
  });

  it('an identical second research result, retyped, sends nothing and logs nothing_new', async () => {
    armed();
    const h = watchHarness(HEARD_HALF, [{ ...HALF, when: 'Sat 9:15 a.m., from Sept. 13' }]);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 0, nothingNew: 1 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.deferredWatches).toHaveLength(1);
  });

  it('POSITIVE CONTROL - a new time sends, and the next watch remembers both', async () => {
    armed();
    const h = watchHarness(HEARD_HALF, [
      { ...HALF, when: 'Saturdays 9:15am and 10:30am from Sept 13' },
    ]);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, nothingNew: 0, watching: 1 });
    expect(h.transport.bodies()).toHaveLength(1);
    expect(h.deferredWatches).toEqual([]);
    expect(h.watched).toEqual([
      expect.objectContaining({
        heardFacts: ['when:date:sep-13', 'when:day:sat', 'when:time:10:30', 'when:time:9:15'],
      }),
    ]);
  });

  it('an opening the parent was not told is news, even on a date they already have', async () => {
    armed();
    const h = watchHarness(HEARD_HALF, [{ ...HALF, registration: 'Registration opens Sept 13' }]);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, nothingNew: 0 });
  });

  it("the coach's first promise always gets its answer - nothing has been heard yet", async () => {
    armed();
    const h = watchHarness(null, [{ ...HALF, when: null }]);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, nothingNew: 0 });
    expect(h.deferredWatches).toEqual([]);
  });
});

describe('a watch ends when the activity is already on the family calendar', () => {
  const WATCH: DueCommitment = { ...DUE, heardFacts: ['when:day:sat', 'when:time:9:15'] };

  it('closes the watch and neither searches nor sends when the calendar holds it', async () => {
    armed();
    let searched = 0;
    const h = harness({ due: [WATCH], calendar: { outcome: 'on_calendar' } });
    h.deps.finder = {
      async find() {
        searched += 1;
        return { found: true, picks: [PICK] };
      },
    };
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ due: 1, sent: 0, onCalendar: 1, nothingNew: 0, failed: 0 });
    expect(h.closedWatches).toEqual([{ commitmentId: WATCH.id, familyId: FAMILY, now: NOW }]);
    expect(searched).toBe(0);
    expect(h.composed).toEqual([]);
    expect(h.transport.bodies()).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(h.deferredWatches).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ commitmentId: WATCH.id, outcome: 'on_calendar' }),
      expect.any(String),
    );
  });

  it('hands the check the watch subject, its heard facts, and the parent it is owed to', async () => {
    armed();
    const h = harness({ due: [WATCH], calendar: { outcome: 'on_calendar' } });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.calendarChecks).toEqual([
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        subjectChildId: null,
        subject: WATCH.topic,
        heardFacts: WATCH.heardFacts,
        now: NOW,
      },
    ]);
  });

  it('POSITIVE CONTROL - a calendar without it lets the watch look and send as before', async () => {
    armed();
    const h = harness({ due: [WATCH], calendar: { outcome: 'not_on_calendar' } });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, onCalendar: 0, calendarUnchecked: 0 });
    expect(h.closedWatches).toEqual([]);
    expect(h.transport.bodies()).toHaveLength(1);
  });

  it.each(['zone_unknown', 'unreadable', 'unsure', 'read_failed'] as const)(
    'a check with no answer (%s) keeps the watch going and is counted and logged',
    async (reason) => {
      armed();
      const h = harness({ due: [WATCH], calendar: { outcome: 'calendar_unchecked', reason } });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const result = await runActivityFollowUpSweep(database, h.deps, NOW);

      expect(result).toMatchObject({ sent: 1, onCalendar: 0, calendarUnchecked: 1 });
      expect(h.closedWatches).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        { commitmentId: WATCH.id, outcome: 'calendar_unchecked', reason },
        expect.any(String),
      );
    },
  );

  it("the coach's first promise is never checked against the calendar", async () => {
    armed();
    const h = harness({ calendar: { outcome: 'on_calendar' } });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ sent: 1, onCalendar: 0 });
    expect(h.calendarChecks).toEqual([]);
    expect(h.closedWatches).toEqual([]);
  });

  it('a held family is not checked - the check comes after the gate', async () => {
    armed();
    const h = harness({ due: [WATCH], hold: 'quiet_hours', calendar: { outcome: 'on_calendar' } });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.calendarChecks).toEqual([]);
  });
});

/**
 * D5 — WHAT LICENSES "THEIR PAGE DOESN'T SAY".
 *
 * The licence is read off the PAGES by the research pass (evidence.ts `readPageVerdict`,
 * tested directly there over real page text) and this sweep only carries it. What is
 * asserted here is that carrying: a shallow snippet answer has opened nothing and must say
 * so, and a deep pass's verdict must arrive at the composer unchanged rather than being
 * recomputed into a second opinion.
 */
describe('the licence to say a page carries nothing', () => {
  it('is withheld from a shallow answer - no page was opened at all', async () => {
    armed();
    const h = harness();

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ pageEvidence: 'no_page_read' });
  });

  it('carries a deep verdict of "the page published nothing" through to the composer', async () => {
    armed();
    const h = harness({
      deep: {
        status: 'read',
        slots: [],
        searchResults: 8,
        pagesRead: 3,
        pagesStale: 2,
        pagesRefused: 0,
        pageVerdict: 'page_has_no_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ pageEvidence: 'page_has_no_schedule' });
  });

  it('THE 2026-08-24 DEFECT: a deep pass that read a schedule it could not pin licenses nothing', async () => {
    // Every row refused, so `slots` is empty - which used to be indistinguishable from a
    // page that published nothing, and was the sentence the parent got.
    armed();
    const h = harness({
      deep: {
        status: 'read',
        slots: [],
        searchResults: 8,
        pagesRead: 3,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.composed[0]).toMatchObject({ pageEvidence: 'page_has_schedule' });
  });

  it('counts a deep leg that never ran, instead of leaving it invisible', async () => {
    armed();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ deep: { status: 'unavailable', reason: 'research_failed' } });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);
    spy.mockRestore();

    // The shape production spent all of 2026-08-22 in, and the only run counter that
    // could have said so.
    expect(result).toMatchObject({ deepRead: 0, deepUnread: 0, deepUnavailable: 1, sent: 1 });
  });
});

/**
 * D4 — THE AUDIT ROW AN OPS READER CAN ACT ON.
 *
 * The 2026-08-22 diagnosis took an hour of live probing because this row said
 * `{"picks":2}`. Counts only, and every count the run actually held.
 */
describe('the audit row carries the evidence', () => {
  it('records what the follow-up searched, opened and was refused', async () => {
    armed();
    const h = harness({
      deep: {
        status: 'read',
        slots: [{ ...PICK, registration: null, sourceUrl: 'https://x.ca/p' } as DeepSlot],
        searchResults: 12,
        pagesRead: 3,
        pagesStale: 0,
        pagesRefused: 2,
        pageVerdict: 'page_has_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(h.audited[0]).toMatchObject({
      actionTaken: 'activity_followup_sent',
      after: {
        picks: 1,
        deepRead: 1,
        deepUnread: 0,
        pagesRead: 3,
        pagesRefused: 2,
        searchResults: 12,
        watch: false,
      },
    });
  });

  it('records the UNREAD shape as its own thing - refused is not read-and-empty', async () => {
    armed();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ deep: { status: 'unread', searchResults: 7, pagesRefused: 4 } });

    await runActivityFollowUpSweep(database, h.deps, NOW);
    spy.mockRestore();

    expect(h.audited[0]).toMatchObject({
      after: { deepRead: 0, deepUnread: 1, pagesRead: 0, pagesRefused: 4, searchResults: 7 },
    });
  });

  it('still carries no venue name, no url and no subject (rule #1)', async () => {
    armed();
    const h = harness({
      deep: {
        status: 'read',
        slots: [{ ...PICK, registration: null, sourceUrl: 'https://x.ca/p' } as DeepSlot],
        searchResults: 12,
        pagesRead: 3,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    await runActivityFollowUpSweep(database, h.deps, NOW);

    const row = JSON.stringify(h.audited);
    expect(row).not.toContain(PICK.name);
    expect(row).not.toContain('https://');
    expect(row).not.toContain('toddler gymnastics');
  });
});

describe('the last read of the string that actually leaves', () => {
  it('THE HOLE: a question in the wire body is refused at the send boundary', async () => {
    armed();
    // The sentence the composer's own gates would never have passed - handed over here
    // the way an append after those gates hands it over: by the time this string exists,
    // `followUpViolations` has already run and said yes to a different one.
    const h = harness({
      compose: {
        status: 'composed',
        message: `${PICK.name} runs Saturdays. Want me to check back once they're up?`,
        mentionsWatch: false,
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ due: 1, sent: 0, refusedAtSend: 1, deferred: 0, failed: 0 });
    // Nothing on the wire, nothing in the thread, and the debt still owed - a refusal
    // here is the next tick's problem, never a message the parent half-gets.
    expect(h.transport.bodies()).toEqual([]);
    expect(h.threaded).toEqual([]);
    expect(h.fulfilled).toEqual([]);
    expect(h.watched).toEqual([]);
  });

  it('VIL-293 - a wire body claiming a row that does not exist is refused, promise left open', async () => {
    armed();
    const h = harness({
      find: { found: true, picks: [PICK] },
      compose: {
        status: 'composed',
        message: `${PICK.name} runs Saturdays. Your spot is booked.`,
        mentionsWatch: false,
      },
      unbacked: ['no_scheduled_row'],
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    expect(result).toMatchObject({ due: 1, sent: 0, refusedAtSend: 1, deferred: 0, failed: 0 });
    expect(h.transport.bodies()).toEqual([]);
    expect(h.threaded).toEqual([]);
    expect(h.fulfilled).toEqual([]);
  });

  it('POSITIVE CONTROL - the two things code DOES append still go out', async () => {
    armed();
    // Three slots, so the text carries two and the third mints a share page: both appends
    // run on this send, which is what makes it the control for the refusal above.
    const slots: DeepSlot[] = [1, 2, 3].map((n) => ({
      ...PICK,
      name: `${PICK.name} ${n}`,
      registration: null,
      sourceUrl: 'https://haltonhillsgymnastics.ca/programs',
    }));
    const h = harness({
      deep: {
        status: 'read',
        slots,
        searchResults: 8,
        pagesRead: 2,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    const result = await runActivityFollowUpSweep(database, h.deps, NOW);

    // The venue page is what code appends after the gate. The opt-out line is not.
    // Neither carries a question mark, and this is the assertion that says so out
    // loud - without it the refusal above would pass just as well on a sweep that
    // sends nothing.
    expect(result).toMatchObject({ sent: 1, refusedAtSend: 0 });
    const sent = h.transport.sent[0]?.body ?? '';
    expect(sent).not.toContain('STOP to opt out.');
    expect(sent).not.toContain('Reply STOP to opt out.');
    expect(sent).toContain('https://haltonhillsgymnastics.ca/programs');
    expect(sent).not.toContain('villagehale.com');
    expect(sent).not.toContain('?');
  });
});
