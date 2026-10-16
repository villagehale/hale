import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { productionChannelCoachPorts } from '~/lib/channel/coach/runtime';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import type { HandlerContext } from '~/lib/channel/router/route';
import { pipelineClient } from '~/lib/pipeline/client';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { registrationReminderFixture } from '~/lib/testing/registration-reminder';
import { registrationSourceFixture } from '~/lib/testing/registration-source';
import type { LiveRegistrationReading } from '../live-reading';
import { createRegistrationPageBytesFetch } from '../page';
import * as registrationReaderModule from '../read';
import { type CycleIdentity, extractPublishedWindow } from '../verify-window';
import { verifyRegistrationDateApproval } from './date-approval';
import { registrationLinkHandler } from './link-handler';
import {
  claimDueRegistrationChecks,
  claimRegistrationSend,
  refreshRegistrationWatch,
  releaseRegistrationSend,
} from './refresh';
import {
  defaultSequenceRunDeps,
  loadLiveSequences,
  registrationTargetFor,
  runRegistrationSequenceCron,
} from './run';
import { openLegWindows } from './schedule';
import { claimRegistrationWatch } from './watch-storage';

let db: TestDb;
const NOW = new Date('2026-10-13T14:00:00Z');
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// These tests drive the SQL, consent and delivery seams, not model quality.
function page(
  url: string,
  date = '2026-10-20',
  time: string | null = '09:00',
  timeZone = 'America/New_York',
): LiveRegistrationReading {
  return {
    status: 'verified',
    reader: 'ai',
    sourceUrl: url,
    timeZone,
    checkedAt: NOW,
    dates: [
      {
        kind: 'general_open',
        date,
        time,
        evidence: [`Registration opens ${date}${time ? ` at ${time}` : ''}`],
      },
    ],
  };
}
async function action(familyId: string, executed = true, now = NOW) {
  const [event] = await db.database
    .insert(schema.events)
    .values({ familyId, source: 'test', eventType: 'registration', dedupHash: randomUUID() })
    .returning({ id: schema.events.id });
  const [row] = await db.database
    .insert(schema.actions)
    .values({
      familyId,
      eventId: event!.id,
      actionType: 'add_to_digest_only',
      payload: {},
      reviewerVerdict: 'approved',
      userVisibleState: executed ? 'autonomous' : 'drafted_for_approval',
      executedAt: executed ? now : null,
    })
    .returning({ id: schema.actions.id });
  return row!.id;
}
async function watch(suffix: string, approved = true, now = NOW) {
  const family = await seedFamily(db.database, `live ${suffix}`);
  const url = `https://example.org/${suffix}`;
  const claimed = await claimRegistrationWatch(db.database, {
    ...family,
    sourceUrl: url,
    now,
  });
  const actionId = await action(family.familyId, approved, now);
  await db.database
    .update(schema.registrationSequences)
    .set({ actionId, courseOpensAt: new Date('2026-10-20T13:00:00Z') })
    .where(eq(schema.registrationSequences.id, claimed.sequenceId));
  return { ...family, sequenceId: claimed.sequenceId, url, actionId };
}
async function row(id: string) {
  return (
    await db.database
      .select()
      .from(schema.registrationSequences)
      .where(eq(schema.registrationSequences.id, id))
  )[0]!;
}
function harness(reading: LiveRegistrationReading, target: Awaited<ReturnType<typeof watch>>) {
  vi.stubEnv('F14_ENABLED', 'true');
  const deps = defaultSequenceRunDeps();
  deps.compose = registrationReminderFixture;
  const transport = new FakeTransport();
  let reads = 0;
  deps.transport = transport;
  deps.loadLiveSequences = async () => loadLiveSequences(db.database, target.sequenceId);
  deps.loadRecipients = async () => [
    { parentUserId: target.parentUserId, role: 'primary_parent', timeZone: 'America/Toronto' },
  ];
  deps.resolveSendablePhone = async () => '+14165550100';
  deps.buildGate = () => ({
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => 0,
    proactiveSentSince: async () => false,
    parentTimeZone: async () => 'America/Toronto',
  });
  deps.refuseUnbackedSend = async () => [];
  deps.threadMessage = async () => 'test-thread';
  deps.recordCommitment = async () => ({ status: 'recorded', commitmentId: randomUUID() });
  deps.fulfillCommitment = async () => ({ status: 'closed', commitmentIds: [] });
  deps.live!.claimDue = async () => [];
  deps.live!.readForSend = async () => {
    reads++;
    return reading;
  };
  deps.live!.draftReview = async () => {};
  return { deps, transport, reads: () => reads };
}

describe('live registration storage → cron → outbound', () => {
  it('passes the watch owner stored language to the household reminder writer', async () => {
    const target = await watch(`language-${randomUUID()}`);
    const h = harness(page(target.url), target);
    h.deps.loadRecipients = async () => [
      {
        parentUserId: target.parentUserId,
        role: 'primary_parent',
        timeZone: 'America/Toronto',
        language: 'fr-CA',
      },
    ];
    const compose = vi.fn(registrationReminderFixture);
    h.deps.compose = compose;
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-13T14:00:00Z'));
    expect(compose).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr-CA' }));
  });
  it.runIf(process.env.VIL423_LIVE_MINUTE_EVAL === 'true').each([
    { audience: 'resident', area: 'L7M', date: '2026-08-22', kind: 'resident_open' },
    { audience: 'non-resident', area: 'L4B', date: '2026-08-28', kind: 'general_open' },
  ])(
    'R12 real official timed reminder for $audience',
    async (sample) => {
      // Real HTTP/model; historical published dates under a fixture clock, never real SMS.
      const url = 'https://www.burlington.ca/en/recreation/registering-for-a-program.aspx';
      const anchor = new Date(`${sample.date}T13:00:00Z`);
      const setupAt = new Date(anchor.getTime() - 8 * 86_400_000);
      const target = await watch(`minute-${sample.audience}`, true, setupAt);
      await db.database.insert(schema.children).values({
        familyId: target.familyId,
        name: 'Maya',
        dateOfBirth: '2022-05-01',
      });
      const source = registrationSourceFixture({
        municipality: 'burlington',
        programDomain: 'swim',
        cycleLabel: 'Fall 2026 swimming lessons',
        sourceUrl: url,
        residentOpenAt: new Date('2026-08-22T13:00:00Z'),
        openAt: new Date('2026-08-28T13:00:00Z'),
      });
      await db.database
        .update(schema.families)
        .set({ areaCoarse: sample.area })
        .where(eq(schema.families.id, target.familyId));
      await db.database
        .update(schema.registrationSequences)
        .set({
          sourceContext: source,
          courseUrl: url,
          courseOpensAt: anchor,
          lastReadAt: setupAt,
          lastReading: {
            status: 'verified',
            reader: 'ai',
            sourceUrl: url,
            timeZone: 'America/Toronto',
            checkedAt: setupAt.toISOString(),
            dates: [
              {
                kind: sample.kind,
                date: '2026-11-26',
                time: '12:00',
                evidence: ['deliberately stale test observation'],
              },
            ],
          },
        })
        .where(eq(schema.registrationSequences.id, target.sequenceId));
      let fetches = 0;
      let extractions = 0;
      const fetchBody = createRegistrationPageBytesFetch();
      const ports = {
        fetchBody: async (sourceUrl: string) => {
          expect(sourceUrl).toBe(url);
          fetches++;
          return fetchBody(sourceUrl);
        },
        extract: async (cycle: CycleIdentity, text: string) => {
          extractions++;
          return extractPublishedWindow(cycle, text, { client: pipelineClient() });
        },
      };
      const sequence = (await loadLiveSequences(db.database, target.sequenceId))[0]!;
      const initial = await registrationReaderModule.createRegistrationReader(ports)(
        registrationTargetFor(sequence),
        setupAt,
      );
      expect(initial).toMatchObject({
        status: 'verified',
        dates: expect.arrayContaining([
          expect.objectContaining({ kind: sample.kind, date: sample.date, time: '09:00' }),
        ]),
      });
      const h = harness(initial, target);
      const deliveries: Array<{ body: string; fetches: number; extractions: number }> = [];
      h.deps.transport = {
        send: async (message) => {
          deliveries.push({ body: message.body, fetches, extractions });
          return h.transport.send(message);
        },
      };
      const tick = async (now: Date) => {
        // Like production default deps, each cron invocation owns a fresh reader/cache.
        h.deps.live.readForSend = registrationReaderModule.createRegistrationReader(ports);
        const result = await runRegistrationSequenceCron(db.database, h.deps, now);
        const saved = await row(target.sequenceId);
        console.info(
          JSON.stringify({
            kind: 'live-minute-tick',
            audience: sample.audience,
            now,
            result,
            fetches,
            extractions,
            anchor: saved.courseOpensAt,
            pausedAt: saved.pausedAt,
            pendingChange: saved.pendingChange,
            lastReading: saved.lastReading,
          }),
        );
        expect(result.failed).toBe(0);
        return result;
      };
      const windows = openLegWindows(anchor, 'America/Toronto');
      expect((await tick(windows.battle_plan.from)).sent).toBe(1);
      const beforeGo = { fetches, extractions };
      await tick(new Date(windows.go.from.getTime() - 60_000));
      expect(h.transport.sent).toHaveLength(1);
      expect({ fetches, extractions }).toEqual(beforeGo);
      expect(windows.go.from.toISOString()).toBe(`${sample.date}T12:45:00.000Z`);
      expect((await tick(windows.go.from)).sent).toBe(1);
      expect(h.transport.sent).toHaveLength(2);
      expect(deliveries[1]).toMatchObject({
        fetches: beforeGo.fetches + 1,
        extractions: beforeGo.extractions + 1,
      });
      const body = h.transport.bodies()[1]!;
      expect(body).toContain(`${sample.date} at 09:00 America/Toronto`);
      expect(body).toContain(url);
      expect(body).not.toMatch(/2026-11-26|12:00|paused|unconfirmed/);
      const saved = await row(target.sequenceId);
      expect(saved.pausedAt).toBeNull();
      expect(saved.lastReading).toMatchObject({
        status: 'verified',
        checkedAt: windows.go.from.toISOString(),
      });
      const afterGo = { fetches, extractions };
      expect((await tick(windows.go.from)).deduped).toBe(1);
      await tick(anchor);
      expect(h.transport.sent).toHaveLength(2);
      expect({ fetches, extractions }).toEqual(afterGo);
      console.info(
        JSON.stringify({
          kind: 'live-minute-eval',
          audience: sample.audience,
          sourceUrl: url,
          simulatedTick: windows.go.from,
          reading: saved.lastReading,
          fetches,
          extractions,
          deliveries,
          duplicateAndLateTicksSentNothing: true,
        }),
      );
    },
    180_000,
  );

  it('keeps both the explicitly classified and unlabelled page openings for Coach', async () => {
    const target = await watch('mixed-eligibility');
    const reading = page(target.url, '2026-10-18');
    if (reading.status !== 'verified') throw new Error('expected verified fixture');
    reading.dates.push({
      kind: 'unclassified_open',
      date: '2026-10-17',
      time: null,
      evidence: ['Earlier opening, eligibility unstated'],
    });
    vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockReturnValue(
      async () => reading,
    );
    const context = await productionChannelCoachPorts(db.database).readRegistrationWatch(
      target.familyId,
      target.sequenceId,
      NOW,
    );
    expect(context).toMatchObject({
      generalOpens: '2026-10-18 at 09:00 America/New_York',
      opensFor: '2026-10-18 at 09:00 America/New_York',
      unclassifiedOpens: '2026-10-17 (opening time not published) America/New_York',
      minuteReminderAvailable: true,
    });
  });
  it('a real reader result keeps an unlabelled opening out of the family schedule', async () => {
    const target = await watch('unlabelled-reader');
    const actualReader = registrationReaderModule.createRegistrationReader;
    const text = 'Toronto. Winter registration begins November 10, 2026 at 09:00.';
    vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockImplementation(() =>
      actualReader({
        fetchBody: async () => text,
        extract: async () => ({
          found: true,
          reason: null,
          cycleOnPage: 'Winter',
          yearEvidence: '2026',
          preview: null,
          residentOpen: null,
          generalOpen: { date: '2026-11-10', time: '09:00' },
          evidence: text,
          confidence: 0.95,
          timeZone: 'America/Toronto',
          timeZoneEvidence: 'Toronto.',
        }),
      }),
    );
    const context = await productionChannelCoachPorts(db.database).readRegistrationWatch(
      target.familyId,
      target.sequenceId,
      NOW,
    );
    expect(context).toMatchObject({
      generalOpens: null,
      residentOpens: null,
      unclassifiedOpens: '2026-11-10 at 09:00 America/Toronto',
      reminderState: 'paused',
      minuteReminderAvailable: false,
    });
    expect(context?.opensFor).toContain('eligibility unconfirmed');
    expect((await row(target.sequenceId)).courseOpensAt?.toISOString()).toBe(
      '2026-10-20T13:00:00.000Z',
    );
  });
  it('exposes the verified page date to Coach but pauses reminders when eligibility is unknown', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const target = await watch('coach-unknown-eligibility');
    const reading = page(target.url, '2026-10-18');
    if (reading.status !== 'verified') throw new Error('expected verified fixture');
    reading.dates[0]!.kind = 'unclassified_open';
    vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockReturnValue(
      async () => reading,
    );
    const context = await productionChannelCoachPorts(db.database).readRegistrationWatch(
      target.familyId,
      target.sequenceId,
      NOW,
    );
    expect(context).toMatchObject({
      unclassifiedOpens: '2026-10-18 at 09:00 America/New_York',
      residentOpens: null,
      generalOpens: null,
      residentsFirst: false,
      reminderState: 'paused',
      minuteReminderAvailable: false,
      sourceUrl: target.url,
    });
    expect(context?.opensFor).toContain('eligibility');
    expect(await row(target.sequenceId)).toMatchObject({
      lastReading: { status: 'verified', dates: [{ kind: 'unclassified_open' }] },
      pendingChange: { kind: 'eligibility_unverified' },
      courseOpensAt: new Date('2026-10-20T13:00:00Z'),
    });
  });

  it('cron sends one eligibility caveat with the live date and URL, never an opening reminder', async () => {
    const target = await watch('cron-unknown-eligibility');
    const reading = page(target.url, '2026-10-18');
    if (reading.status !== 'verified') throw new Error('expected verified fixture');
    reading.dates[0]!.kind = 'unclassified_open';
    const h = harness(reading, target);
    h.deps.live!.claimDue = async () => [target.sequenceId];
    h.deps.live!.read = async () => reading;
    expect((await runRegistrationSequenceCron(db.database, h.deps, NOW)).failed).toBe(0);
    expect(h.transport.sent).toHaveLength(1);
    const body = h.transport.bodies()[0]!;
    expect(body).toContain('2026-10-18 at 09:00 America/New_York');
    expect(body).toContain('eligibility');
    expect(body).toContain('Date reminders are paused');
    expect(body).toContain(target.url);
    expect(body).not.toMatch(
      /2026-10-20|couldn't verify a current registration date|can register/i,
    );
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-18T12:45:00Z'));
    expect(h.transport.sent).toHaveLength(1);
    expect((await row(target.sequenceId)).pausedAt).not.toBeNull();
  });

  it('lists every watch without dates or page reads, and scopes on-demand reads to its family', async () => {
    const target = await watch('coach-metadata');
    for (let index = 0; index < 8; index++) {
      await claimRegistrationWatch(db.database, {
        familyId: target.familyId,
        parentUserId: target.parentUserId,
        sourceUrl: `https://example.org/metadata-${index}`,
        now: NOW,
      });
    }
    const read = vi.fn(async (target: registrationReaderModule.RegistrationTarget) =>
      page(target.sourceUrl),
    );
    vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockReturnValue(read);
    const ports = productionChannelCoachPorts(db.database);
    const watches = await ports.loadRegistrationWatches(target.familyId);
    expect(watches).toHaveLength(9);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(watches)).not.toMatch(/courseOpensAt|lastReading|2026-10-20/);
    const last = watches[8];
    if (!last) throw new Error('expected ninth watch');
    const other = await seedFamily(db.database, 'other family');
    expect(await ports.readRegistrationWatch(other.familyId, last.id, NOW)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(await ports.readRegistrationWatch(target.familyId, last.id, NOW)).toMatchObject({
      sourceUrl: last.sourceUrl,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a scheduled check catches 20th → 18th before the old reminder is due, then sends the new ladder', async () => {
    const at = new Date('2026-10-12T14:00:00Z');
    const target = await watch('before-old-due', true, at);
    expect(
      openLegWindows(new Date('2026-10-20T13:00:00Z'), 'America/Toronto').heads_up.from > at,
    ).toBe(true);
    const live = { ...page(target.url, '2026-10-18'), checkedAt: at };
    const h = harness(live, target);
    h.deps.live!.claimDue = async () => [target.sequenceId];
    h.deps.live!.read = async (_target, now) => ({ ...live, checkedAt: now });
    h.deps.live!.readForSend = async (_target, now) => ({ ...live, checkedAt: now });
    const change = await runRegistrationSequenceCron(db.database, h.deps, at);
    expect(change.sent).toBe(1);
    expect((await row(target.sequenceId)).courseOpensAt).toEqual(new Date('2026-10-18T13:00:00Z'));
    const headsUp = await runRegistrationSequenceCron(db.database, h.deps, at);
    expect(headsUp.sent).toBe(1);
    const evening = await runRegistrationSequenceCron(
      db.database,
      h.deps,
      new Date('2026-10-17T23:00:00Z'),
    );
    expect(evening.sent).toBe(1);
    expect(h.transport.sent).toHaveLength(3);
    for (const body of h.transport.bodies()) {
      expect(body).toContain('2026-10-18');
      expect(body).toContain(target.url);
      expect(body).not.toContain('2026-10-20');
    }
  });

  it.each(['uncorroborated', 'eligibility_unverified', 'not_published'] as const)(
    'a scheduled %s hold informs the parent with the URL, never the cached date',
    async (reason) => {
      const target = await watch(`held-${reason}`);
      const reading: LiveRegistrationReading = {
        sourceUrl: target.url,
        checkedAt: NOW,
        timeZone: 'America/New_York',
        reader: 'ai',
        status: 'unverified',
        reason,
      };
      const h = harness(reading, target);
      h.deps.live!.claimDue = async () => [target.sequenceId];
      h.deps.live!.read = async () => reading;
      const result = await runRegistrationSequenceCron(db.database, h.deps, NOW);
      expect(result.failed).toBe(0);
      expect(h.transport.sent).toHaveLength(1);
      expect(h.transport.bodies()[0]).toContain("couldn't verify");
      expect(h.transport.bodies()[0]).toContain(target.url);
      expect(h.transport.bodies()[0]).not.toMatch(/2026-10-20|Oct(?:ober)? 20|09:00|9:00/);
      expect((await row(target.sequenceId)).pausedAt).not.toBeNull();
      await runRegistrationSequenceCron(db.database, h.deps, NOW);
      expect(h.transport.sent).toHaveLength(1);
    },
  );

  it.each([false, true])(
    'a Coach live read persists the later date and reports paused reminders (window-bound=%s)',
    async (windowBound) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const target = await watch(`coach-${windowBound}`);
      if (windowBound) {
        const window = registrationSourceFixture({
          municipality: 'halton_hills',
          programDomain: 'swim',
          cycleLabel: randomUUID(),
          openAt: new Date('2026-10-20T13:00:00Z'),
          sourceUrl: target.url,
          verifiedAt: NOW,
        });
        await db.database
          .update(schema.registrationSequences)
          .set({
            windowId: window!.id,
            sourceContext: window,
            courseUrl: null,
            courseOpensAt: null,
          })
          .where(eq(schema.registrationSequences.id, target.sequenceId));
      }
      // Replace the I/O reader only. Model answer quality is covered by the real Coach eval.
      vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockReturnValue(async () =>
        page(target.url, '2026-10-22'),
      );
      const context = await productionChannelCoachPorts(db.database).readRegistrationWatch(
        target.familyId,
        target.sequenceId,
        NOW,
      );
      expect(context).toMatchObject({
        opensFor: '2026-10-22 at 09:00 America/New_York',
        residentOpens: null,
        generalOpens: '2026-10-22 at 09:00 America/New_York',
        reminderState: 'paused',
      });
      expect(await row(target.sequenceId)).toMatchObject({
        lastReadAt: NOW,
        courseUrl: target.url,
        pendingChange: { kind: 'later' },
        lastReading: { status: 'verified' },
        courseOpensAt: new Date('2026-10-20T13:00:00Z'),
      });
    },
  );
  it.each([false, true])(
    "keeps both live eligibility tiers distinct from this family's resident status (%s)",
    async (resident) => {
      const target = await watch(`coach-tiers-${resident}`);
      await db.database
        .update(schema.families)
        .set({ areaCoarse: resident ? 'L4B' : 'L7M' })
        .where(eq(schema.families.id, target.familyId));
      const sourceContext = registrationSourceFixture({
        municipality: 'richmond_hill',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2026-2027',
        openAt: new Date('2026-11-26T17:00:00Z'),
        residentOpenAt: new Date('2026-11-26T17:00:00Z'),
        sourceUrl: target.url,
      });
      await db.database
        .update(schema.registrationSequences)
        .set({ sourceContext, windowId: sourceContext.id })
        .where(eq(schema.registrationSequences.id, target.sequenceId));
      const reading = page(target.url, '2026-12-01', null, 'America/Toronto');
      if (reading.status !== 'verified') throw new Error('expected verified fixture');
      reading.dates.unshift({
        kind: 'resident_open',
        date: '2026-11-24',
        time: null,
        evidence: ['Resident registration: November 24, 2026'],
      });
      vi.spyOn(registrationReaderModule, 'createRegistrationReader').mockReturnValue(
        async () => reading,
      );
      const context = await productionChannelCoachPorts(db.database).readRegistrationWatch(
        target.familyId,
        target.sequenceId,
        NOW,
      );
      expect(context).toMatchObject({
        residentsFirst: resident,
        opensFor: `${resident ? '2026-11-24' : '2026-12-01'} (opening time not published) America/Toronto`,
        residentOpens: '2026-11-24 (opening time not published) America/Toronto',
        generalOpens: '2026-12-01 (opening time not published) America/Toronto',
      });
      vi.mocked(registrationReaderModule.createRegistrationReader).mockReturnValue(async () => ({
        sourceUrl: target.url,
        checkedAt: NOW,
        timeZone: 'America/Toronto',
        reader: 'ai',
        status: 'unreadable',
        reason: 'fetch_failed',
      }));
      const held = await productionChannelCoachPorts(db.database).readRegistrationWatch(
        target.familyId,
        target.sequenceId,
        NOW,
      );
      expect(held).toMatchObject({
        residentOpens: null,
        generalOpens: null,
        reminderState: 'paused',
      });
      expect(held?.opensFor).not.toMatch(/2026-11-24|2026-12-01/);
    },
  );

  it('moves only matching open plan and watch deadlines, using their distinct clocks', async () => {
    const target = await watch('promise-deadlines');
    const oldAnchor = new Date('2026-10-20T13:00:00Z');
    const anchor = new Date('2026-10-18T13:00:00Z');
    for (const kind of ['registration_plan', 'registration_watch'] as const) {
      await db.database.insert(schema.agentCommitments).values({
        familyId: target.familyId,
        commitmentKind: kind,
        createdFrom: 'test',
        summary: kind,
        dueAt:
          kind === 'registration_watch'
            ? oldAnchor
            : openLegWindows(oldAnchor, 'America/Toronto').battle_plan.until,
      });
    }
    await db.database.insert(schema.agentCommitments).values({
      familyId: target.familyId,
      commitmentKind: 'registration_watch',
      createdFrom: 'old',
      summary: 'closed promise',
      dueAt: oldAnchor,
      fulfilledAt: NOW,
      fulfilledBy: 'test',
    });
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-18'),
      resident: false,
      now: NOW,
    });
    const promises = await db.database
      .select()
      .from(schema.agentCommitments)
      .where(eq(schema.agentCommitments.familyId, target.familyId));
    expect(promises.find((value) => value.commitmentKind === 'registration_plan')?.dueAt).toEqual(
      openLegWindows(anchor, 'America/Toronto').battle_plan.until,
    );
    expect(
      promises.find((value) => value.commitmentKind === 'registration_watch' && !value.fulfilledAt)
        ?.dueAt,
    ).toEqual(anchor);
    expect(promises.find((value) => value.fulfilledAt)?.dueAt).toEqual(oldAnchor);
    await db.database
      .update(schema.agentCommitments)
      .set({ dueAt: new Date('2026-11-01T13:00:00Z') })
      .where(eq(schema.agentCommitments.familyId, target.familyId));
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-17'),
      resident: false,
      now: NOW,
    });
    expect(
      (
        await db.database
          .select()
          .from(schema.agentCommitments)
          .where(eq(schema.agentCommitments.familyId, target.familyId))
      ).every((value) => value.dueAt?.toISOString() === '2026-11-01T13:00:00.000Z'),
    ).toBe(true);
  });
  it('wrong cached date never becomes an outbound fact; the source moves it earlier', async () => {
    const target = await watch('wrong-cache');
    const live = page(target.url, '2026-10-18');
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: live,
      resident: false,
      now: NOW,
    });
    const h = harness(live, target);
    const sent = await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(sent.sent).toBe(1);
    expect(h.transport.bodies()[0]).toContain('2026-10-18 at 09:00 America/New_York');
    expect(h.transport.bodies()[0]).not.toContain('2026-10-20');
    expect((await row(target.sequenceId)).courseOpensAt).toEqual(new Date('2026-10-18T13:00:00Z'));
    expect((await row(target.sequenceId)).pendingChange?.notified).toBe(true);
  });
  it('an ordinary tick and an already-sent stage do not fetch a page', async () => {
    const target = await watch('dedupe');
    const h = harness(page(target.url), target);
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-01T14:00:00Z'));
    expect(h.reads()).toBe(0);
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.reads()).toBe(1);
  });
  it('later dates pause the old anchor and require the separately approved candidate to still match', async () => {
    const target = await watch('postponed');
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-22'),
      resident: false,
      now: NOW,
    });
    expect((await row(target.sequenceId)).pausedAt).not.toBeNull();
    const reviewId = await action(target.familyId, false);
    await db.database
      .update(schema.registrationSequences)
      .set({ dateReviewActionId: reviewId })
      .where(eq(schema.registrationSequences.id, target.sequenceId));
    expect(
      await verifyRegistrationDateApproval(
        db.database,
        { familyId: target.familyId, actionId: reviewId, now: NOW },
        async () => page(target.url, '2026-10-22'),
      ),
    ).toBe('verified');
    await db.database
      .update(schema.actions)
      .set({ executedAt: NOW })
      .where(eq(schema.actions.id, reviewId));
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-22'),
      resident: false,
      now: NOW,
    });
    expect(await row(target.sequenceId)).toMatchObject({
      pausedAt: null,
      courseOpensAt: new Date('2026-10-22T13:00:00Z'),
      actionId: target.actionId,
    });
  });
  it('a changed candidate invalidates the previous YES rather than resuming', async () => {
    const target = await watch('changed-again');
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-22'),
      resident: false,
      now: NOW,
    });
    const reviewId = await action(target.familyId, true);
    await db.database
      .update(schema.registrationSequences)
      .set({ dateReviewActionId: reviewId })
      .where(eq(schema.registrationSequences.id, target.sequenceId));
    expect(
      await verifyRegistrationDateApproval(
        db.database,
        { familyId: target.familyId, actionId: reviewId, now: NOW },
        async () => page(target.url, '2026-10-23'),
      ),
    ).toBe('changed');
    expect(await row(target.sequenceId)).toMatchObject({
      dateReviewActionId: null,
      actionId: target.actionId,
      pendingChange: { candidateAt: '2026-10-23T13:00:00.000Z' },
    });
    expect((await row(target.sequenceId)).pausedAt).not.toBeNull();
  });
  it('a failed notification remains pending and a retry sends it once', async () => {
    const target = await watch('send-retry');
    const reading: LiveRegistrationReading = {
      ...page(target.url),
      status: 'unreadable',
      reason: 'fetch_failed',
    };
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading,
      resident: false,
      now: NOW,
    });
    const h = harness(reading, target);
    h.deps.transport = {
      send: async () => {
        throw new Error('provider down');
      },
    };
    expect((await runRegistrationSequenceCron(db.database, h.deps, NOW)).failed).toBe(1);
    expect((await row(target.sequenceId)).pendingChange?.notified).toBe(false);
    h.deps.transport = h.transport;
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(1);
    expect((await row(target.sequenceId)).pendingChange?.notified).toBe(true);
  });
  it('pending approval cannot send a full evening/go reminder', async () => {
    const target = await watch('pending', false);
    const h = harness(page(target.url), target);
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-19T23:00:00Z'));
    expect(h.transport.sent).toHaveLength(0);
    expect(h.reads()).toBe(0);
  });
  it('an unavailable opening date does not stop a reported waitlist offer deadline', async () => {
    const target = await watch('waitlist-independent');
    const window = registrationSourceFixture({
      municipality: 'halton_hills',
      programDomain: 'swim',
      cycleLabel: randomUUID(),
      openAt: NOW,
      sourceUrl: target.url,
      verifiedAt: NOW,
      waitlistResponseHours: 48,
    });
    await db.database
      .update(schema.registrationSequences)
      .set({
        windowId: window!.id,
        sourceContext: window,
        outcome: 'waitlisted',
        waitlistStartedAt: new Date(NOW.getTime() - 25 * 3_600_000),
        pausedAt: NOW,
      })
      .where(eq(schema.registrationSequences.id, target.sequenceId));
    const failed = {
      ...page(target.url),
      status: 'unreadable',
      reason: 'fetch_failed',
    } as LiveRegistrationReading;
    const h = harness(failed, target);
    h.deps.loadChildren = async () => [
      {
        id: randomUUID(),
        name: 'Child',
        gender: 'girl',
        dateOfBirth: '2020-01-01',
        dobPrecision: 'exact',
      },
    ];
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.bodies()[0]).toContain('waitlist');
    expect(h.transport.bodies()[0]).not.toContain('2026-10-20');
    expect((await row(target.sequenceId)).pausedAt).not.toBeNull();
  });
  it('leases exclude concurrent refreshes and concurrent sends and expire after a crash', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const target = await watch('lease');
    const results = await Promise.all([
      claimDueRegistrationChecks(db.database, NOW),
      claimDueRegistrationChecks(db.database, NOW),
    ]);
    expect(results.flat().filter((id) => id === target.sequenceId)).toHaveLength(1);
    const leases = await Promise.all([
      claimRegistrationSend(db.database, target.sequenceId, NOW),
      claimRegistrationSend(db.database, target.sequenceId, NOW),
    ]);
    expect(leases.filter((token) => token !== null)).toHaveLength(1);
    expect(
      await claimRegistrationSend(
        db.database,
        target.sequenceId,
        new Date(NOW.getTime() + 241_000),
      ),
    ).not.toBeNull();
    await releaseRegistrationSend(
      db.database,
      target.sequenceId,
      Math.floor(NOW.getTime() / 1000) + 481,
    );
  });
  it('URL-only sequences load without pretending there is a GTA window', async () => {
    const target = await watch('no-window');
    const [loaded] = await loadLiveSequences(db.database, target.sequenceId);
    expect(loaded).toMatchObject({ window: null, courseUrl: target.url, optIn: 'opted_in' });
  });
  it('a failed read keeps the pending candidate and does not revoke a valid review', async () => {
    const target = await watch('failure-candidate');
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-22'),
      resident: false,
      now: NOW,
    });
    const reviewId = await action(target.familyId, false);
    await db.database
      .update(schema.registrationSequences)
      .set({ dateReviewActionId: reviewId })
      .where(eq(schema.registrationSequences.id, target.sequenceId));
    const failed = {
      ...page(target.url),
      status: 'unreadable',
      reason: 'fetch_failed',
    } as LiveRegistrationReading;
    expect(
      await verifyRegistrationDateApproval(
        db.database,
        { familyId: target.familyId, actionId: reviewId, now: NOW },
        async () => failed,
      ),
    ).toBe('unverified');
    expect(await row(target.sequenceId)).toMatchObject({
      dateReviewActionId: reviewId,
      pendingChange: {
        kind: 'unavailable',
        reviewCandidate: { candidateAt: '2026-10-22T13:00:00.000Z' },
      },
    });
    expect(
      await verifyRegistrationDateApproval(
        db.database,
        { familyId: target.familyId, actionId: reviewId, now: NOW },
        async () => page(target.url, '2026-10-22'),
      ),
    ).toBe('verified');
  });
  it('approval withdrawn during the page read prevents transport', async () => {
    const target = await watch('withdrawn');
    const h = harness(page(target.url), target);
    h.deps.live!.readForSend = async () => {
      await db.database
        .update(schema.actions)
        .set({ revertedAt: NOW })
        .where(eq(schema.actions.id, target.actionId));
      return page(target.url);
    };
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(0);
  });
  it('date-only sends an evening plan without claiming noon, and never sends a go or premature check-in', async () => {
    const target = await watch('date-only');
    const live = page(target.url, '2026-10-20', null);
    await db.database
      .update(schema.registrationSequences)
      .set({ courseOpensAt: new Date('2026-10-20T16:00:00Z') })
      .where(eq(schema.registrationSequences.id, target.sequenceId));
    const h = harness(live, target);
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-19T23:00:00Z'));
    expect(h.transport.bodies()[0]).toContain('opening time not published');
    expect(h.transport.bodies()[0]).not.toContain('12:00');
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-20T15:45:00Z'));
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-20T20:15:00Z'));
    expect(h.transport.sent).toHaveLength(1);
    await runRegistrationSequenceCron(db.database, h.deps, new Date('2026-10-21T14:00:00Z'));
    expect(h.transport.sent).toHaveLength(2);
    expect(h.transport.bodies()[1]).toContain('How did registration go?');
  });
  it('bounded cron selection respects the family allowlist', async () => {
    const target = await watch('allowlisted');
    vi.stubEnv('F14_ENABLED', 'false');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', target.familyId);
    const selected = await loadLiveSequences(db.database, undefined, undefined, NOW);
    expect(selected.map((value) => value.familyId)).toEqual([target.familyId]);
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
    expect(await loadLiveSequences(db.database, undefined, undefined, NOW)).toEqual([]);
  });
  it('a pending watch is not proof of an active reminder promise', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const target = await watch('consent-proof', false);
    expect(
      await loadReconcileView(db.database, { familyId: target.familyId, now: NOW }),
    ).toMatchObject({ registrationLaddered: false, mintableWindow: null });
    await db.database
      .update(schema.actions)
      .set({ executedAt: NOW })
      .where(eq(schema.actions.id, target.actionId));
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url),
      resident: false,
      now: NOW,
    });
    expect(
      await loadReconcileView(db.database, { familyId: target.familyId, now: NOW }),
    ).toMatchObject({
      registrationLaddered: true,
      mintableWindow: { opensForFamilyAt: new Date('2026-10-20T13:00:00Z') },
    });
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: page(target.url, '2026-10-22'),
      resident: false,
      now: NOW,
    });
    expect(
      await loadReconcileView(db.database, { familyId: target.familyId, now: NOW }),
    ).toMatchObject({ registrationLaddered: false, mintableWindow: null });
  });
  it('a partial two-parent delivery retries only the unsent recipient', async () => {
    const target = await watch('two-parent-retry');
    const [co] = await db.database
      .insert(schema.users)
      .values({ email: `${randomUUID()}@example.test`, name: 'Co parent' })
      .returning({ id: schema.users.id });
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: target.familyId, userId: co!.id, role: 'co_parent' });
    const live = page(target.url, '2026-10-18');
    await refreshRegistrationWatch(db.database, {
      sequenceId: target.sequenceId,
      reading: live,
      resident: false,
      now: NOW,
    });
    const h = harness(live, target);
    h.deps.loadRecipients = async () => [
      { parentUserId: target.parentUserId, role: 'primary_parent', timeZone: 'America/Toronto' },
      { parentUserId: co!.id, role: 'co_parent', timeZone: 'America/Toronto' },
    ];
    let attempts = 0;
    h.deps.transport = {
      send: async (input) => {
        if (++attempts === 2) throw new Error('second parent transport down');
        return h.transport.send(input);
      },
    };
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(1);
    expect((await row(target.sequenceId)).pendingChange?.notified).toBe(false);
    await runRegistrationSequenceCron(db.database, h.deps, NOW);
    expect(h.transport.sent).toHaveLength(2);
    expect((await row(target.sequenceId)).pendingChange?.notified).toBe(true);
  });
});

describe('course link entry', () => {
  it('keeps an unclassified date in the course-link reply and proposal, without promising scheduled reminders', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const family = await seedFamily(db.database, 'link eligibility');
    const url = 'https://example.org/unknown-eligibility';
    const reading = page(url, '2026-10-18');
    if (reading.status !== 'verified') throw new Error('expected verified fixture');
    reading.dates[0]!.kind = 'unclassified_open';
    let summary = '';
    const handler = registrationLinkHandler({
      readRequest: async () => ({ intent: 'inspect', confidence: 'high', needsLocation: false }),
      reader: () => async () => reading,
      draft: async (_database, input) => {
        summary = input.summary;
        return action(family.familyId, false);
      },
      approve: async () => {
        throw new Error('a bare link is not approval');
      },
    });
    const response = await handler.handle(db.database, {
      ...family,
      body: url,
      now: NOW,
      conversationId: randomUUID(),
      inboundChannelMessageId: null,
      resolved: null,
      openQuestions: async () => [],
      send: async () => ({ channel: 'sms', channelMessageId: null, providerMessageId: 'test' }),
    });
    expect(response.claimed).toBe(true);
    if (!response.claimed) throw new Error('expected claimed link');
    expect(response.reply).toContain('2026-10-18 at 09:00 America/New_York');
    expect(response.reply).toContain('eligibility');
    expect(response.reply).toContain(url);
    expect(summary).toContain('eligibility');
    expect(summary).not.toMatch(
      /Approve to receive a reminder a week ahead|fifteen minutes before/i,
    );
    const [saved] = await loadLiveSequences(db.database, undefined, family.familyId);
    expect(saved?.pausedAt).not.toBeNull();
    expect(saved?.courseOpensAt).toBeNull();
  });
  it.each(['America/New_York', 'Europe/London'])(
    'creates an unapproved watch for a public %s course, without a window',
    async (zone) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const family = await seedFamily(db.database, zone);
      const url = `https://example.org/${zone}`;
      let approvals = 0;
      const handler = registrationLinkHandler({
        readRequest: vi
          .fn()
          .mockResolvedValueOnce({ intent: 'inspect', confidence: 'high', needsLocation: false })
          .mockResolvedValueOnce({ intent: 'remind', confidence: 'high', needsLocation: false }),
        reader: () => async () => page(url, '2026-10-20', '09:00', zone),
        draft: async () => action(family.familyId, false),
        approve: async () => {
          approvals++;
        },
      });
      const context: HandlerContext = {
        ...family,
        body: url,
        now: NOW,
        conversationId: randomUUID(),
        inboundChannelMessageId: null,
        resolved: null,
        openQuestions: async () => [],
        send: async () => ({ channel: 'sms', channelMessageId: null, providerMessageId: 'test' }),
      };
      expect((await handler.handle(db.database, context)).claimed).toBe(true);
      const [saved] = await loadLiveSequences(db.database, undefined, family.familyId);
      expect(saved).toMatchObject({
        window: null,
        courseUrl: url,
        optIn: 'pending',
        lastReading: { timeZone: zone },
      });
      expect(approvals).toBe(0);
      expect(
        (
          await handler.handle(db.database, {
            ...context,
            body: `remind me when registration opens ${url}`,
          })
        ).claimed,
      ).toBe(true);
      expect(approvals).toBe(1);
      expect(await loadLiveSequences(db.database, undefined, family.familyId)).toHaveLength(1);
    },
  );
  it('bare YES and unrelated links are not a new course subscription', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    const family = await seedFamily(db.database, 'unrelated');
    const handler = registrationLinkHandler({
      readRequest: async () => ({ intent: 'none', confidence: 'high', needsLocation: false }),
      reader: () => async () => {
        throw new Error('must not read');
      },
      draft: async () => {
        throw new Error('must not draft');
      },
      approve: async () => {
        throw new Error('must not approve');
      },
    });
    const context = { ...family, body: 'YES', now: NOW } as HandlerContext;
    expect((await handler.handle(db.database, context)).claimed).toBe(false);
    expect(
      (
        await handler.handle(db.database, {
          ...context,
          body: 'add this birthday invitation https://example.org/party',
        })
      ).claimed,
    ).toBe(false);
  });

  it.each([
    'Préviens-moi à l’ouverture des inscriptions.',
    'Avísame cuando se abran las inscripciones.',
    'ذكرني عند فتح التسجيل.',
  ])('uses model-read reminder intent rather than English/Chinese words: %s', async (text) => {
    vi.stubEnv('F14_ENABLED', 'true');
    const family = await seedFamily(db.database, 'model intent');
    const url = `https://example.org/${randomUUID()}`;
    const readRequest = vi.fn(async () => ({
      intent: 'remind' as const,
      confidence: 'high' as const,
      needsLocation: false,
    }));
    const approve = vi.fn(async () => {});
    const handler = registrationLinkHandler({
      readRequest,
      reader: () => async () => page(url),
      draft: async () => action(family.familyId, false),
      approve,
    });
    const response = await handler.handle(db.database, {
      ...family,
      body: `${text} ${url}`,
      now: NOW,
    } as HandlerContext);
    expect(response).toMatchObject({ claimed: true, outcome: 'registration_reminder_requested' });
    expect(readRequest).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledOnce();
  });

  it.each([
    {
      text: 'remind me when it opens, but actually do not set any reminders',
      intent: 'inspect',
      confidence: 'high',
    },
    { text: 'remind me? I have not decided', intent: 'remind', confidence: 'low' },
    { text: 'register this birthday invitation', intent: 'none', confidence: 'high' },
  ] as const)(
    'does not approve from suggestive words when the model reads $intent/$confidence',
    async ({ text, intent, confidence }) => {
      vi.stubEnv('F14_ENABLED', 'true');
      const family = await seedFamily(db.database, 'no implicit consent');
      const url = `https://example.org/${randomUUID()}`;
      const approve = vi.fn(async () => {});
      const reader = vi.fn(async () => page(url));
      const handler = registrationLinkHandler({
        readRequest: async () => ({ intent, confidence, needsLocation: false }),
        reader: () => reader,
        draft: async () => action(family.familyId, false),
        approve,
      });
      const response = await handler.handle(db.database, {
        ...family,
        body: `${text} ${url}`,
        now: NOW,
      } as HandlerContext);
      expect(approve).not.toHaveBeenCalled();
      if (intent === 'none' || confidence === 'low') {
        expect(response.claimed).toBe(false);
        expect(reader).not.toHaveBeenCalled();
        expect(await loadLiveSequences(db.database, undefined, family.familyId)).toHaveLength(0);
      } else {
        expect(response).toMatchObject({
          claimed: true,
          outcome: 'registration_reminder_proposed',
        });
      }
    },
  );
});
