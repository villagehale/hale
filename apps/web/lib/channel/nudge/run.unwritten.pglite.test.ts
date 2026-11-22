import type { AgentClient } from '@hale/agent';
import { type Municipality, type ProgramDomain, type RegistrationWindow, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { pageOps } from '~/lib/monitoring/failure-page';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  MAX_UNDATED_ASK_FAILURES,
  type NudgeModelOnlyDeps,
  type NudgeRunDeps,
  UNDATED_ASK_FAILURE_WINDOW_DAYS,
  countRecentAskFailures,
  defaultNudgeModelOnlyDeps,
  defaultNudgeRunDeps,
  runNudgeCron,
} from './run';

/**
 * Dec 1 rule 1 (NUDGE_MODEL_ONLY_ENABLED on) over real Postgres, with the REAL composer, audit writer, #ops pager and
 * draft count. Only the world is faked: the phone, the Slack post, and the model's
 * transport, which answers with a stated draft so the check is what decides.
 */

const TZ = 'America/Toronto';
/** 10:00 in Toronto, the family's nudge slot. */
const NOW = new Date('2026-07-31T14:00:00.000Z');
const AREA = 'L4C';
const PHONE = '+15555550100';

/** Claude's own answer for this nudge's facts (nudge eval, 1kid-window-soon). */
const GOOD_DRAFT =
  "Richmond Hill Fall 2026 registration opens Aug 5, 10:30 a.m. - that's the one for Maya.";
const INVENTED_DRAFT = 'Richmond Hill Fall 2026 registration opens at 9:15 for Maya.';
/** Claude's own answer for the undated ask (weekday-care-ask eval, weekend-fallback). */
const GOOD_ASK =
  "Hey, I just noticed everything I've sent you so far has been for the weekend. Want me to look at weekday stuff too?";
const REFUSED_ASK = 'Want weekday stuff too? Tuesday at 9:15?';

/** The family's same morning slot, `days` later. */
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

let db: TestDb;
let familyId: string;
let parentUserId: string;
let posted: string[];

const WINDOW = {
  id: '00000000-0000-4000-8000-0000000000a1',
  municipality: 'richmond_hill' as Municipality,
  programDomain: 'rec_program' as ProgramDomain,
  cycleLabel: 'Fall 2026',
  district: null,
  ageMinMonths: 36,
  ageMaxMonths: 72,
  previewAt: null,
  openAt: new Date('2026-08-05T14:30:00.000Z'),
  residentOpenAt: null,
  residentPriorityDays: null,
  closesAt: null,
  waitlistResponseHours: null,
  sourceUrl: 'https://example.org/register',
  verifiedAt: NOW,
  notes: null,
  createdAt: NOW,
  updatedAt: NOW,
} as RegistrationWindow;

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => false,
  parentTimeZone: async () => TZ,
});

function answering(draft: string): { client: AgentClient; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: JSON.stringify({ message: draft }) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  }));
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

function throwing(): AgentClient {
  const fail = vi.fn(async () => {
    throw new Error('model unavailable');
  });
  return { messages: { create: fail, stream: fail } } as unknown as AgentClient;
}

function deps(transport: FakeTransport, client: AgentClient | null): NudgeRunDeps {
  return {
    ...defaultNudgeRunDeps(),
    selectFamilies: async () => [
      {
        familyId,
        parentUserId,
        areaCoarse: AREA,
        timeZone: TZ,
        provisionedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ],
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' as const }],
    loadCandidates: async () => [],
    loadWindows: async () => [WINDOW],
    weather: { getDailyOutlook: async () => [] },
    resolveSendablePhone: async () => PHONE,
    buildGate: openGate,
    transport,
    client,
  };
}

/** The real writer, count and pager; only the Slack post is faked. */
function modelOnlyDeps(): NudgeModelOnlyDeps {
  return {
    ...defaultNudgeModelOnlyDeps(),
    page: (database, page) =>
      pageOps(database, page, {
        post: async (text) => {
          posted.push(text);
          return 'sent';
        },
      }),
  };
}

const sweep = (runDeps: NudgeRunDeps, at: Date) =>
  runNudgeCron(db.database, runDeps, at, modelOnlyDeps());

/** The undated weekday-care ask is the only rung this family reaches. */
function askDeps(transport: FakeTransport, client: AgentClient | null): NudgeRunDeps {
  return {
    ...deps(transport, client),
    loadWindows: async () => [],
    loadWeekdayCareContext: async () => ({
      stated: [],
      askedBefore: false,
      weekendFindSent: true,
    }),
  };
}

async function unwrittenRows() {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'proactive_nudge_unwritten'),
      ),
    );
  return rows.map((row) => row.after as Record<string, unknown>);
}

async function ledgerRows() {
  return db.database
    .select({ status: schema.channelMessages.status })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table families, users, rate_limits cascade');
  vi.unstubAllEnvs();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('NUDGE_MODEL_ONLY_ENABLED', 'true');
  // With every default-off flag on (CI's advisory job), these stop or reroute a send
  // before the writer runs. Off here, so the writer's failure is what the test sees.
  vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.stubEnv('REGISTRATION_DATE_CHECK', 'off');
  posted = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Maple + kids',
      provinceOrState: 'ON',
      city: 'Richmond Hill',
      areaCoarse: AREA,
      province: 'ON',
      country: 'Canada',
      onboardingStage: 'sms_active',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: schema.families.id });
  familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:unwritten', name: 'Rowan', timezone: TZ })
    .returning({ id: schema.users.id });
  parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Maya', dateOfBirth: '2023-07-01' });
});

describe('a nudge the model could not write, over real Postgres', () => {
  it('with no client: nothing sent, nothing on the ledger, one audit row, one page', async () => {
    const transport = new FakeTransport();
    const result = await sweep(deps(transport, null), NOW);

    expect(result).toMatchObject({ sent: 0, unwritten: 1, resting: 0, failed: 0 });
    expect(transport.sent).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
    expect(await unwrittenRows()).toEqual([
      { reason: 'unvoiced', kind: 'registration', unwritten: 'no_client' },
    ]);
    expect(posted).toEqual([
      'Hale: ops page. site nudge_unwritten. kind registration. reason no_client.',
    ]);
  }, 30_000);

  it('a dated nudge keeps its tries: the model recovers before the window opens and it sends', async () => {
    const transport = new FakeTransport();
    const bad = answering(INVENTED_DRAFT);
    for (const day of [0, 1, 2]) {
      const result = await sweep(deps(transport, bad.client), at(day));
      expect(result).toMatchObject({ sent: 0, unwritten: 1, failed: 0 });
    }
    expect(await unwrittenRows()).toHaveLength(3);
    expect(transport.sent).toEqual([]);

    const good = answering(GOOD_DRAFT);
    const recovered = await sweep(deps(transport, good.client), at(3));

    expect(recovered).toMatchObject({ sent: 1, unwritten: 0, failed: 0 });
    expect(transport.bodies()).toEqual([GOOD_DRAFT]);
    expect(await ledgerRows()).toEqual([{ status: 'queued' }]);
  }, 30_000);

  it('a dated nudge ends with its own date: past the opening nothing asks the model', async () => {
    const transport = new FakeTransport();
    const bad = answering(INVENTED_DRAFT);
    await sweep(deps(transport, bad.client), at(0));
    const drafted = bad.create.mock.calls.length;

    // Aug 6: the Aug 5 window has opened, so the decide no longer picks it.
    const after = await sweep(deps(transport, bad.client), at(6));

    expect(after).toMatchObject({ sent: 0, unwritten: 0, quiet: 1, failed: 0 });
    // The preflight probe is the only call left: no draft is asked for.
    expect(bad.create.mock.calls.length).toBe(drafted + 1);
    expect(await unwrittenRows()).toHaveLength(1);
    expect(transport.sent).toEqual([]);
  }, 30_000);

  it('the undated ask rests after failures of any kind, and a fixed writer sends it', async () => {
    vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true');
    const transport = new FakeTransport();
    const refusedDraft = answering(JSON.stringify({ message: REFUSED_ASK }));
    const failures: Array<[number, AgentClient | null, string]> = [
      [0, null, 'no_client'],
      [1, throwing(), 'model_failed'],
      [2, refusedDraft.client, 'unusable'],
    ];
    expect(failures).toHaveLength(MAX_UNDATED_ASK_FAILURES);
    for (const [day, client] of failures) {
      const result = await sweep(askDeps(transport, client), at(day));
      expect(result).toMatchObject({ sent: 0, unwritten: 1, resting: 0, failed: 0 });
    }
    const rows = await unwrittenRows();
    expect(rows.map((row) => row.unwritten)).toEqual(failures.map(([, , reason]) => reason));
    expect(new Set(rows.map((row) => row.nudgeRef)).size).toBe(1);
    // The row is family-visible: the ref is a digest, not the family id.
    expect(String(rows[0]?.nudgeRef)).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain(familyId);
    const pagesBefore = posted.length;

    const good = answering(GOOD_ASK);
    const resting = await sweep(askDeps(transport, good.client), at(3));
    expect(resting).toMatchObject({ sent: 0, unwritten: 0, resting: 1, failed: 0 });
    // The preflight probe is the only call: no draft is asked for.
    expect(good.create).toHaveBeenCalledTimes(1);
    expect(await unwrittenRows()).toHaveLength(MAX_UNDATED_ASK_FAILURES);
    expect(posted).toHaveLength(pagesBefore);

    // Day 8 is the first slot where the day-0 failure is outside the window.
    const day = UNDATED_ASK_FAILURE_WINDOW_DAYS + 1;
    const back = await sweep(askDeps(transport, good.client), at(day));
    expect(back).toMatchObject({ sent: 1, unwritten: 0, resting: 0, failed: 0 });
    expect(transport.bodies()).toEqual([GOOD_ASK]);
  }, 60_000);

  it('an undated ask that never recovers is tried three days in eight, not every day', async () => {
    vi.stubEnv('WEEKDAY_CARE_ENABLED', 'true');
    const transport = new FakeTransport();
    const attempted: number[] = [];
    for (let day = 0; day < 21; day += 1) {
      const result = await sweep(askDeps(transport, throwing()), at(day));
      if (result.unwritten === 1) attempted.push(day);
    }
    expect(attempted).toEqual([0, 1, 2, 8, 9, 10, 16, 17, 18]);
    expect(transport.sent).toEqual([]);
  }, 120_000);

  it.each(['no_client', 'skill_load', 'model_failed', 'unusable'])(
    'the ask failure count includes %s, inside the window and for this ask only',
    async (reason) => {
      const ref = 'a'.repeat(32);
      const row = (nudgeRef: string, occurredAt: Date) => ({
        familyId,
        actor: 'system',
        actionTaken: 'proactive_nudge_unwritten',
        targetTable: 'families',
        targetId: familyId,
        occurredAt,
        after: { reason: 'unvoiced', kind: 'weekday_care', unwritten: reason, nudgeRef },
      });
      const since = at(-UNDATED_ASK_FAILURE_WINDOW_DAYS);
      await db.database
        .insert(schema.auditLog)
        .values([
          row(ref, at(-1)),
          row(ref, new Date(since.getTime() - 1)),
          row('b'.repeat(32), at(-1)),
        ]);
      expect(await countRecentAskFailures(db.database, familyId, ref, since)).toBe(1);
    },
    30_000,
  );

  it('History leaves out a failed write, and the rights export keeps it', async () => {
    const DELIBERATE_QUIET = 'Hale had nothing worth interrupting you for';
    const FAILED_WRITE = 'Hale could not write a heads-up, so it sent nothing';
    await sweep(deps(new FakeTransport(), null), NOW);
    // The positive control: a deliberate quiet is still on History.
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_skipped',
      targetTable: 'families',
      targetId: familyId,
      after: { reason: 'nothing_worth_saying' },
    });

    const history = (await loadTrailForFamily(db.database, familyId)).map((row) => row.summary);
    expect(history).toContain(DELIBERATE_QUIET);
    expect(history).not.toContain(FAILED_WRITE);

    const copy = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      now: NOW,
    });
    expect(copy.trail.map((row) => row.summary)).toContain(FAILED_WRITE);
  }, 30_000);

  it('flag off: the same family gets the fixed sentence, no failure row and no page', async () => {
    vi.stubEnv('NUDGE_MODEL_ONLY_ENABLED', '');
    const transport = new FakeTransport();
    const result = await sweep(deps(transport, null), NOW);

    expect(result).toMatchObject({ sent: 1, unwritten: 0, resting: 0, failed: 0 });
    expect(transport.bodies()).toEqual([
      'Richmond Hill Fall 2026 registration opens Aug 5, 10:30 a.m. for Maya.',
    ]);
    expect(await unwrittenRows()).toEqual([]);
    expect(posted).toEqual([]);
  }, 30_000);

  it('positive control: the good draft goes out word for word and pages nobody', async () => {
    const transport = new FakeTransport();
    const { client } = answering(GOOD_DRAFT);
    const result = await sweep(deps(transport, client), NOW);

    expect(result).toMatchObject({ sent: 1, unwritten: 0, resting: 0, failed: 0 });
    expect(transport.bodies()).toEqual([GOOD_DRAFT]);
    expect(await ledgerRows()).toEqual([{ status: 'queued' }]);
    expect(await unwrittenRows()).toEqual([]);
    expect(posted).toEqual([]);
  }, 30_000);
});
