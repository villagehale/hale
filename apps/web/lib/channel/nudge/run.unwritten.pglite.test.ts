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
  MAX_UNUSABLE_NUDGE_DRAFTS,
  type NudgeRunDeps,
  countUnusableNudgeDrafts,
  defaultNudgeRunDeps,
  runNudgeCron,
} from './run';

/**
 * Dec 1 rule 1 over real Postgres, with the REAL composer, audit writer, #ops pager and
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
    page: (database, page) =>
      pageOps(database, page, {
        post: async (text) => {
          posted.push(text);
          return 'sent';
        },
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
    const result = await runNudgeCron(db.database, deps(transport, null), NOW);

    expect(result).toMatchObject({ sent: 0, unwritten: 1, settled: 0, failed: 0 });
    expect(transport.sent).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
    const rows = await unwrittenRows();
    expect(rows).toEqual([
      {
        reason: 'unvoiced',
        kind: 'registration',
        unwritten: 'no_client',
        nudgeRef: expect.stringMatching(/^[0-9a-f]{32}$/),
        settled: false,
      },
    ]);
    // The row is family-visible: the ref is a digest, not the window or the family id.
    expect(JSON.stringify(rows)).not.toContain(WINDOW.id);
    expect(JSON.stringify(rows)).not.toContain(familyId);
    expect(posted).toEqual([
      'Hale: ops page. site nudge_unwritten. kind registration. reason no_client.',
    ]);
  }, 30_000);

  it('a draft that fails the check settles after the bound, unsent', async () => {
    const transport = new FakeTransport();
    const { client, create } = answering(INVENTED_DRAFT);

    for (let attempt = 1; attempt <= MAX_UNUSABLE_NUDGE_DRAFTS; attempt += 1) {
      const result = await runNudgeCron(db.database, deps(transport, client), NOW);
      expect(result).toMatchObject({ sent: 0, unwritten: 1, settled: 0, failed: 0 });
    }
    const draftCalls = create.mock.calls.length;
    const rows = await unwrittenRows();
    expect(new Set(rows.map((row) => row.nudgeRef)).size).toBe(1);
    expect(await countUnusableNudgeDrafts(db.database, familyId, String(rows[0]?.nudgeRef))).toBe(
      MAX_UNUSABLE_NUDGE_DRAFTS,
    );
    expect(rows.map((row) => row.unwritten)).toEqual(
      Array(MAX_UNUSABLE_NUDGE_DRAFTS).fill('unusable'),
    );
    expect(rows.map((row) => row.settled)).toEqual([
      ...Array(MAX_UNUSABLE_NUDGE_DRAFTS - 1).fill(false),
      true,
    ]);
    expect(posted[0]).toBe(
      'Hale: ops page. site nudge_unwritten. kind registration. reason unusable.',
    );
    expect(posted).toHaveLength(1);

    const after = await runNudgeCron(db.database, deps(transport, client), NOW);
    expect(after).toMatchObject({ sent: 0, unwritten: 0, settled: 1, failed: 0 });
    // The preflight probe is the only call left: no draft is asked for.
    expect(create.mock.calls.length).toBe(draftCalls + 1);
    expect(await unwrittenRows()).toHaveLength(MAX_UNUSABLE_NUDGE_DRAFTS);
    expect(transport.sent).toEqual([]);
    expect(await ledgerRows()).toEqual([]);
  }, 30_000);

  it('counts only this nudge, and only a draft that failed its check', async () => {
    const ref = 'a'.repeat(32);
    const row = (after: Record<string, unknown>) => ({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_nudge_unwritten',
      targetTable: 'families',
      targetId: familyId,
      after,
    });
    await db.database.insert(schema.auditLog).values([
      row({ reason: 'unvoiced', kind: 'registration', unwritten: 'unusable', nudgeRef: ref }),
      row({ reason: 'unvoiced', kind: 'registration', unwritten: 'no_client', nudgeRef: ref }),
      row({ reason: 'unvoiced', kind: 'registration', unwritten: 'model_failed', nudgeRef: ref }),
      row({
        reason: 'unvoiced',
        kind: 'registration',
        unwritten: 'unusable',
        nudgeRef: 'b'.repeat(32),
      }),
    ]);
    expect(await countUnusableNudgeDrafts(db.database, familyId, ref)).toBe(1);
  }, 30_000);

  it('History leaves out a failed write, and the rights export keeps it', async () => {
    const DELIBERATE_QUIET = 'Hale had nothing worth interrupting you for';
    const FAILED_WRITE = 'Hale could not write a heads-up, so it sent nothing';
    await runNudgeCron(db.database, deps(new FakeTransport(), null), NOW);
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

  it('positive control: the good draft goes out word for word and pages nobody', async () => {
    const transport = new FakeTransport();
    const { client } = answering(GOOD_DRAFT);
    const result = await runNudgeCron(db.database, deps(transport, client), NOW);

    expect(result).toMatchObject({ sent: 1, unwritten: 0, settled: 0, failed: 0 });
    expect(transport.bodies()).toEqual([GOOD_DRAFT]);
    expect(await ledgerRows()).toEqual([{ status: 'queued' }]);
    expect(await unwrittenRows()).toEqual([]);
    expect(posted).toEqual([]);
  }, 30_000);
});
