import type { Database } from '@hale/db';
import type { DeepResearchPayload } from '@hale/tools-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_ALLOWLIST_ENV, F14_ENABLED_ENV } from '~/lib/channel/f14';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ProactiveHoldReason } from '~/lib/channel/outbound-gate';
import type { DueCommitment } from '~/lib/commitments/ledger';
import type { DeepResult } from './deep';
import { type DeepJobDeps, runDeepResearchJob } from './deep-job';
import type { DeepSlot } from './deep';

/**
 * THE QUESTION-TIME JOB, and the one property every case is a variation on:
 * A PROMISE IS NEVER LOST BY TRYING HARDER TO KEEP IT.
 *
 * This lane is an optimisation. It exists to answer in four minutes what the hourly sweep
 * would answer within the day, and every way it can fail has to leave the parent no worse
 * off than if it had never run: the ledger row open, the sweep still selecting it, and the
 * reason on the record. A deep job that closed a promise it did not answer would be
 * strictly worse than not having built it.
 *
 * The composer's words are the eval's job (rule #8); what is here is what happens around
 * them.
 */

const FAMILY = 'fam-1';
const PARENT = 'parent-1';
const COMMITMENT = 'commit-1';
const NOW = new Date('2026-08-24T18:00:00.000Z');

const PAYLOAD: DeepResearchPayload = {
  commitment_id: COMMITMENT,
  family_id: FAMILY,
};

const OPEN: DueCommitment = {
  id: COMMITMENT,
  familyId: FAMILY,
  topic: 'Cartwheels Gym Centre fall schedule',
  summary: 'A promise to come back with what I find on Cartwheels Gym Centre fall schedule',
  createdFrom: 'msg-9',
  subjectChildId: null,
  dueAt: new Date('2026-08-25T18:00:00.000Z'),
};

const SLOT: DeepSlot = {
  name: 'Tiny Gym, Cartwheels Gym Centre',
  ageFit: 'walking to 3.5 years',
  when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
  price: '$124 per term',
  registration: 'Open since July 22',
  sourceName: 'Cartwheels Gym Centre',
  sourceUrl: 'https://cartwheelsgymcentre.example/programs',
  source: 'web',
};

/** The page every backed fixture quotes off. Real refutation, real quotes. */
const PAGE_TEXT =
  'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26. $124 per term. Registration has been open since July 22.';

const READ: DeepResult = {
  status: 'read',
  slots: [SLOT],
  searchResults: 12,
  pagesRead: 3,
  pagesStale: 0,
  pagesRefused: 1,
        pageVerdict: 'page_has_schedule',
};

/**
 * The lane's TWO PORTS scripted to produce a given {@link DeepResult} — and nothing else
 * faked.
 *
 * `runDeepLane` runs for real inside the job: the fan-out settles three legs, the merge's
 * rows go through the actual refutation, and only quote-backed rows reach the send path.
 * That is deliberate — a harness that stubbed the whole lane could not notice the job
 * sending a row the adversarial pass had refused.
 */
function scriptedLane(result: DeepResult): DeepJobDeps['lane'] {
  const read = result.status === 'read';
  // `unavailable` is scripted as legs that never completed, `unread` as legs that
  // searched and opened nothing — the two roads to "no pages", kept apart here because
  // the lane keeps them apart and the job answers them differently.
  const legStatus = read ? 'read' : result.status === 'unread' ? 'unread' : 'failed';
  return {
    researcher: {
      async research(_query, angle) {
        return {
          angle,
          status: legStatus,
          searchResults: legStatus === 'failed' ? 0 : 4,
          pagesRead: read ? 1 : 0,
          pagesStale: 0,
          pagesRefused: legStatus === 'unread' ? 2 : 0,
          pages: read ? [{ url: SLOT.sourceUrl, text: PAGE_TEXT }] : [],
          notes: read ? PAGE_TEXT : '',
          pagesTruncated: 0,
          reason: legStatus === 'failed' ? 'research_failed: timed out' : null,
        };
      },
    },
    synthesiser: {
      async merge() {
        if (result.status === 'unavailable') {
          return { status: 'unavailable', reason: 'synthesis_failed' };
        }
        if (result.status === 'unread') return { status: 'unavailable', reason: 'nothing_read' };
        return {
          status: 'synthesised',
          rows: result.slots.map((slot) => ({
            name: slot.name,
            age_fit: slot.ageFit,
            when: slot.when,
            when_quote: 'Tiny Gym Sundays 9:30-10:15, Sept 14 to Oct 26',
            price: slot.price,
            price_quote: '$124 per term',
            registration: slot.registration,
            registration_quote: 'Registration has been open since July 22',
            source_name: slot.sourceName,
            source_url: slot.sourceUrl,
          })),
        };
      },
    },
  };
}

const database = {} as Database;

afterEach(() => {
  delete process.env[F14_ENABLED_ENV];
  delete process.env[F14_ALLOWLIST_ENV];
  vi.restoreAllMocks();
});

interface Harness {
  deps: DeepJobDeps;
  transport: FakeTransport;
  fulfilled: unknown[];
  cancelled: unknown[];
  threaded: string[];
  audited: Array<Record<string, unknown>>;
  watched: unknown[];
}

function harness(
  overrides: {
    open?: DueCommitment | null;
    hold?: ProactiveHoldReason;
    dedupe?: boolean;
    result?: DeepResult;
    compose?: Awaited<ReturnType<DeepJobDeps['delivery']['composer']['compose']>>;
    unbacked?: Awaited<ReturnType<DeepJobDeps['delivery']['refuseUnbackedSend']>>;
  } = {},
): Harness {
  process.env[F14_ENABLED_ENV] = 'true';
  const transport = new FakeTransport();
  const fulfilled: unknown[] = [];
  const cancelled: unknown[] = [];
  const threaded: string[] = [];
  const audited: Array<Record<string, unknown>> = [];
  const watched: unknown[] = [];

  const deps: DeepJobDeps = {
    loadOpen: async () => (overrides.open === undefined ? OPEN : overrides.open),
    resolveRecipient: async () => ({ parentUserId: PARENT, conversationId: 'conv-1' }),
    reader: {
      municipality: async () => 'halton_hills',
      stage: async () => 'toddler',
      householdNames: async () => ['Noah'],
    },
    buildGate: () => ({
      channelEnrolled: async () => overrides.hold !== 'not_enrolled',
      watchConsentGranted: async () => overrides.hold !== 'no_watch_consent',
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => true,
      // 18:00Z is 23:00 in Karachi, inside the 21:00-08:00 proactive floor; in Toronto it
      // is 14:00 and squarely outside it.
      parentTimeZone: async () =>
        overrides.hold === 'quiet_hours' ? 'Asia/Karachi' : 'America/Toronto',
    }),
    dedupeActive: async () => overrides.dedupe ?? false,
    // THE LANE, DRIVEN THROUGH ITS TWO REAL PORTS. `runDeepLane` itself is production
    // code here — the fan-out, the merge and the refutation all run — and only the WEB
    // and the MERGE's words are fixtures. So a slot only reaches the send path if it
    // survives the real adversarial pass, which is the property this file leans on.
    lane: scriptedLane(overrides.result ?? READ),
    delivery: {
      composer: {
        async compose() {
          return overrides.compose ?? { status: 'composed', message: 'Tiny Gym runs Sundays 9:30.' };
        },
      },
      sharePage: async () => ({ status: 'skipped' as const, reason: 'nothing_to_share' as const }),
      refuseUnbackedSend: async () => overrides.unbacked ?? [],
      resolveSendablePhone: async () => '+14165550100',
      transport,
      recordSend: async () => 'msg-out-1',
      audit: async (_db, row) => {
        audited.push(row);
      },
      threadMessage: async (_db, input) => {
        threaded.push(input.body);
        return 'conv-1';
      },
      fulfillCommitment: async (_db, input) => {
        fulfilled.push(input);
        return { status: 'closed' as const, commitmentIds: [COMMITMENT] };
      },
      recordWatch: async (_db, input) => {
        watched.push(input);
        return { status: 'recorded' as const, commitmentId: 'commit-2' };
      },
    },
    cancelPromise: async (_db, input) => {
      cancelled.push(input);
      return { status: 'closed' as const, commitmentIds: [COMMITMENT] };
    },
  };

  return { deps, transport, fulfilled, cancelled, threaded, audited, watched };
}

describe('runDeepResearchJob', () => {
  it('sends the second message and closes the promise when the pages backed the facts', async () => {
    const h = harness();

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome.status).toBe('sent');
    expect(h.transport.sent).toHaveLength(1);
    // Threaded, so the parent's reply arrives as an ordinary coach turn with the finds
    // above it (#531).
    expect(h.threaded).toEqual(['Tiny Gym runs Sundays 9:30.']);
    // KEPT, against the message that kept it.
    expect(h.fulfilled).toEqual([
      { familyId: FAMILY, kind: 'activity_followup', channelMessageId: 'msg-out-1', now: NOW },
    ]);
  });

  it('claims the send under the SAME dedupe key the hourly sweep would use', async () => {
    const h = harness();
    const keys: string[] = [];
    const deps: DeepJobDeps = {
      ...h.deps,
      delivery: {
        ...h.deps.delivery,
        recordSend: async (_db, write) => {
          keys.push(write.dedupeKey);
          return 'msg-out-1';
        },
      },
    };

    await runDeepResearchJob(database, PAYLOAD, deps, NOW);

    expect(keys).toEqual([`activity_followup:${COMMITMENT}`]);
  });

  /** THE FALLBACK FIXTURE. The lane could not run at all. */
  it('leaves the promise OPEN and sends nothing when the deep pass is unavailable', async () => {
    const h = harness({ result: { status: 'unavailable', reason: 'research_failed' } });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'left_open', reason: 'deep_unavailable' });
    expect(h.transport.sent).toEqual([]);
    // The promise is untouched, so the hourly sweep still owes this family an answer.
    expect(h.fulfilled).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it('leaves the promise OPEN when every fetch was refused - it never says a page carries nothing', async () => {
    const h = harness({ result: { status: 'unread', searchResults: 12, pagesRefused: 6 } });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'left_open', reason: 'deep_unread' });
    expect(h.transport.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
  });

  it('leaves the promise OPEN when the refutation left nothing standing', async () => {
    // A poisoned row: real-looking, cited to a page no leg opened. The REAL refutation
    // drops it, so the job has read pages and nothing to say.
    const h = harness({
      result: {
        status: 'read',
        slots: [{ ...SLOT, sourceUrl: 'https://invented.example/schedule' }],
        searchResults: 12,
        pagesRead: 3,
        pagesStale: 0,
        pagesRefused: 0,
        pageVerdict: 'page_has_schedule',
      },
    });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'left_open', reason: 'all_refuted' });
    expect(h.transport.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
  });

  it('drops without sending when the promise is already closed', async () => {
    const h = harness({ open: null });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'dropped', reason: 'not_open' });
    expect(h.transport.sent).toEqual([]);
  });

  it('drops when the sweep already claimed the send for this promise', async () => {
    const h = harness({ dedupe: true });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'dropped', reason: 'already_sent' });
    expect(h.transport.sent).toEqual([]);
  });

  it('holds at quiet hours and leaves the promise for the morning sweep', async () => {
    const h = harness({ hold: 'quiet_hours' });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'held', reason: 'quiet_hours' });
    expect(h.transport.sent).toEqual([]);
    expect(h.fulfilled).toEqual([]);
  });

  it('voids the promise when the family can no longer be texted at all', async () => {
    const h = harness({ hold: 'not_enrolled' });

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(h.cancelled).toEqual([{ familyId: FAMILY, now: NOW }]);
  });

  it('sends nothing at all while F14 is dark for this family', async () => {
    const h = harness();
    delete process.env[F14_ENABLED_ENV];

    const outcome = await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(outcome).toEqual({ status: 'dropped', reason: 'dark' });
    expect(h.transport.sent).toEqual([]);
  });

  it('writes the refusal counts onto the audit row, so a lane dropping rows is visible', async () => {
    const h = harness();

    await runDeepResearchJob(database, PAYLOAD, h.deps, NOW);

    expect(h.audited).toHaveLength(1);
    expect(h.audited[0]?.after).toMatchObject({
      legsRead: expect.any(Number),
      slotsRefused: expect.any(Number),
      factsRefused: expect.any(Number),
    });
    // COUNTS ONLY - no venue, no url, no subject (rule #1).
    expect(JSON.stringify(h.audited[0])).not.toContain('Cartwheels');
    expect(JSON.stringify(h.audited[0])).not.toContain('https://');
  });
});
