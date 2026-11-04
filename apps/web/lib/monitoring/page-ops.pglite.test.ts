import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupPlan } from '~/lib/channel/group-plan/send';
import { productionGroupPlanReportPorts } from '~/lib/channel/group-plan/send';
import {
  FakeAnswerComposer,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
} from '~/lib/channel/intake/fakes';
import { type IntakeDeps, handleInboundSms } from '~/lib/channel/intake/machine';
import { type OptOutReading, createOptOutReader } from '~/lib/channel/intake/opt-out-reader';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { createGroupConflictWriter } from '~/lib/channel/linq/group-conflict-voice';
import { composeSharedGroupLine } from '~/lib/channel/linq/shared-group-voice';
import { createSpokenLineWriter } from '~/lib/channel/spoken-line';
import { type CrisisUnanswered, logCrisisUnanswered } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { recordedModel } from '~/lib/testing/recorded-model';
import {
  ALERTED_COUNT,
  CLAIM_EPOCH,
  CRISIS_ANSWERED_ROUTE,
  CRISIS_UNANSWERED_PAGE_ROUTE,
  OPS_PAGE_ROUTE,
  failurePageCrisisPager,
  failurePageOpsPager,
  noteCrisisUnanswered,
  pageFailureAlerts,
  pageOps,
} from './failure-page';

/**
 * VIL-602 · every path that says it pages #ops pages through failure-page.ts. Against the
 * real DDL: the claim is a rate_limits row, and the dedupe is its unique index. Only the
 * Slack post is faked, at the pager's port (or at the webhook fetch, for the writers that
 * use the production pager).
 */

/** A skill that cannot be loaded, switched on per test: the real loader otherwise. */
const skillLoad = vi.hoisted(() => ({ fail: false }));
vi.mock('~/lib/cron/skill', async (importOriginal) => {
  const real = await importOriginal<typeof import('~/lib/cron/skill')>();
  return {
    ...real,
    loadCronSkill: async (name: string) => {
      if (skillLoad.fail) throw new Error('skill missing');
      return real.loadCronSkill(name);
    },
  };
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const HOUR = 3_600_000;
const BASE = new Date('2026-11-02T10:15:00.000Z');
const WEBHOOK = 'https://hooks.example.test/ops';

let db: TestDb;
let posted: string[];

const post = async (text: string) => {
  posted.push(text);
  return 'sent' as const;
};

/** Real Claude, recorded once (HALE_RECORD=1): the writers' success path, never scripted. */
const RECORDINGS = join(__dirname, '__recordings__', 'ops-page-writers.json');
const recorded = () => recordedModel(RECORDINGS, () => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));

const CLASH: Parameters<ReturnType<typeof createGroupConflictWriter>['write']>[0] = {
  language: 'en',
  kids: ['Robin'],
  items: [
    { kind: 'plan', title: 'swim lesson', day: 'Saturday', start: '9:00', end: '10:00', has: null },
    {
      kind: 'plan',
      title: 'piano lesson',
      day: 'Saturday',
      start: '9:30',
      end: '10:15',
      has: null,
    },
  ],
  suggested: null,
  alsoFree: [],
  busy: [],
  couldAsk: [],
  poll: null,
};

/** The throw a model client makes when the provider is down. Failure injection only: no
 * model output is ever stood in for. */
const downClient = (): AgentClient => {
  throw new Error('provider down');
};

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  posted = [];
  skillLoad.fail = false;
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec(
    'truncate table rate_limits, opt_out_held_messages, audit_log, channel_messages, sms_intake_sessions, family_members, families, users cascade',
  );
});

/** The webhook the production pager posts to, faked at fetch. */
function stubWebhook(): void {
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
}

/** The database with every rate_limits insert throwing, as when the ledger is failing. */
function claimsThrow(database: Database): Database {
  return new Proxy(database, {
    get(target, prop, receiver) {
      if (prop === 'insert') {
        return (table: unknown) => {
          if (table === schema.rateLimits) throw new Error('database down');
          return target.insert(table as typeof schema.rateLimits);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function claims(route: string) {
  return db.database
    .select({
      id: schema.rateLimits.id,
      identifier: schema.rateLimits.identifier,
      count: schema.rateLimits.count,
      windowStart: schema.rateLimits.windowStart,
    })
    .from(schema.rateLimits)
    .where(eq(schema.rateLimits.route, route));
}

describe('pageOps: the one primitive', () => {
  it('pages once per site per hour; another site, or the next hour, pages again', async () => {
    const page = { site: 'spoken_line_unwritten' as const, facts: { purpose: 'group_welcome' } };
    expect(await pageOps(db.database, page, { post, now: BASE })).toBe('paged');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site spoken_line_unwritten.');
    expect(posted[0]).toContain('purpose group_welcome.');

    expect(await pageOps(db.database, page, { post, now: new Date(BASE.getTime() + 60_000) })).toBe(
      'already_paged',
    );
    expect(posted).toHaveLength(1);

    // Positive controls: the dedupe is per site and per hour, not "once ever".
    expect(
      await pageOps(db.database, { site: 'opt_out_unread', facts: {} }, { post, now: BASE }),
    ).toBe('paged');
    expect(posted).toHaveLength(2);
    expect(await pageOps(db.database, page, { post, now: new Date(BASE.getTime() + HOUR) })).toBe(
      'paged',
    );
    expect(posted).toHaveLength(3);
  });

  it('a post that did not leave releases the claim, so the next occurrence pages', async () => {
    const page = { site: 'group_plan_unwritten' as const, facts: { change: 'moved' } };
    const refused = async () => 'failed' as const;
    expect(await pageOps(db.database, page, { post: refused, now: BASE })).toBe('page_failed');
    expect(await claims(OPS_PAGE_ROUTE)).toEqual([]);
    expect(await pageOps(db.database, page, { post, now: BASE })).toBe('paged');
    expect(posted).toHaveLength(1);
    const unconfigured = async () => 'skipped_not_configured' as const;
    expect(
      await pageOps(
        db.database,
        { site: 'opt_out_unread', facts: {} },
        { post: unconfigured, now: BASE },
      ),
    ).toBe('page_not_configured');
  });

  it('a fact named page cannot overwrite the site in the log', async () => {
    await pageOps(
      db.database,
      { site: 'opt_out_unread', facts: { page: 'spoken_line_unwritten', stage: 'x' } },
      { post, now: new Date(BASE.getTime() + 70 * HOUR) },
    );
    const urgent = vi
      .mocked(console.error)
      .mock.calls.find((call) => call[1] === 'URGENT: opt_out_unread - paging #ops');
    expect(urgent?.[0]).toMatchObject({ page: 'opt_out_unread', stage: 'x' });
  });

  it('a phone-shaped fact never reaches the page', async () => {
    await pageOps(
      db.database,
      { site: 'opt_out_hold_unwritten', facts: { err: 'x5555550123', 'Bad Key': 'kept' } },
      { post, now: BASE },
    );
    expect(posted[0]).toContain('err redacted.');
    expect(posted[0]).not.toContain('5555550123');
    expect(posted[0]).not.toContain('kept');
  });

  it('a claim that throws is deduped in this process, per site and hour', async () => {
    const failing = claimsThrow(db.database);
    // An hour no other test uses: the in-process memo outlives one test.
    const at = new Date(BASE.getTime() + 50 * HOUR);
    const page = { site: 'opt_out_hold_unwritten' as const, facts: { err: 'Error' } };
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) outcomes.push(await pageOps(failing, page, { post, now: at }));
    expect(outcomes).toEqual(['paged', 'already_paged', 'already_paged']);
    expect(posted).toHaveLength(1);
    // Positive control: the next hour pages again.
    expect(await pageOps(failing, page, { post, now: new Date(at.getTime() + HOUR) })).toBe(
      'paged',
    );
    expect(posted).toHaveLength(2);
  });

  it('a pager whose database cannot be resolved still pages, deduped in this process', async () => {
    // An hour no other test uses: the in-process memo outlives one test.
    const at = new Date(BASE.getTime() + 60 * HOUR);
    const pager = failurePageOpsPager(
      () => {
        throw new Error('DATABASE_URL is not set');
      },
      { post, now: at },
    );
    const page = { site: 'opt_out_unread' as const, facts: {} };
    expect([await pager.page(page), await pager.page(page)]).toEqual(['paged', 'already_paged']);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site opt_out_unread.');
  });
});

describe('each site family pages through the primitive', () => {
  it('a spoken line no model could write pages spoken_line_unwritten, once an hour', async () => {
    const writer = createSpokenLineWriter(
      downClient,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    expect(await writer.write({ purpose: 'group_welcome', language: 'en' })).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site spoken_line_unwritten.');
    expect(posted[0]).toContain('stage after_retry.');
    expect(await writer.write({ purpose: 'group_welcome', language: 'en' })).toBeNull();
    expect(posted).toHaveLength(1);
  }, 30_000);

  it('a spoken line whose skill will not load pages spoken_line_unwritten at skill_load', async () => {
    skillLoad.fail = true;
    // vitest.setup.ts imports spoken-line before this file's mock exists: load it afresh.
    vi.resetModules();
    const fresh = await import('~/lib/channel/spoken-line');
    const writer = fresh.createSpokenLineWriter(
      recorded().client,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    expect(await writer.write({ purpose: 'group_welcome', language: 'en' })).toBeNull();
    expect(posted).toEqual([
      'Hale: ops page. site spoken_line_unwritten. purpose group_welcome. stage skill_load.',
    ]);
  }, 30_000);

  it('positive control: a spoken line the model wrote pages nobody', async () => {
    const model = recorded();
    const writer = createSpokenLineWriter(
      model.client,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    const text = await writer.write({ purpose: 'group_welcome', language: 'en' });
    expect(model.misses).toEqual([]);
    expect(text?.trim().length ?? 0).toBeGreaterThan(0);
    expect(posted).toEqual([]);
  }, 30_000);

  it('a group clash alert no model could write pages group_conflict_unwritten', async () => {
    const writer = createGroupConflictWriter(
      downClient,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    expect(await writer.write(CLASH)).toBeNull();
    expect(await writer.write(CLASH)).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site group_conflict_unwritten.');
  }, 30_000);

  it('a clash alert whose skill will not load pages group_conflict_unwritten at skill_load', async () => {
    skillLoad.fail = true;
    const writer = createGroupConflictWriter(
      recorded().client,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    expect(await writer.write(CLASH)).toBeNull();
    expect(posted).toEqual(['Hale: ops page. site group_conflict_unwritten. stage skill_load.']);
  }, 30_000);

  it('positive control: a clash alert the model wrote pages nobody', async () => {
    const model = recorded();
    const writer = createGroupConflictWriter(
      model.client,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    const alert = await writer.write(CLASH);
    expect(model.misses).toEqual([]);
    expect(alert?.text.trim().length ?? 0).toBeGreaterThan(0);
    expect(posted).toEqual([]);
  }, 30_000);

  it('an opt-out read that fails twice pages opt_out_unread', async () => {
    const reader = createOptOutReader(
      downClient,
      failurePageOpsPager(() => db.database, { post, now: BASE }),
    );
    expect(await reader.read({ text: 'please stop', language: null })).toBeNull();
    expect(await reader.read({ text: 'something else', language: null })).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toBe('Hale: ops page. site opt_out_unread.');
    expect(posted[0]).not.toContain('please stop');
  }, 30_000);

  it('a shared-group line no model could write pages shared_group_unwritten and audits', async () => {
    stubWebhook();
    const { familyId } = await seedFamily(db.database, 'Alder Family');
    const failing = {
      async compose(): Promise<never> {
        throw new Error('provider down');
      },
    };
    const input = {
      familyId,
      request: { kind: 'intro' as const, adderFirstName: null },
      language: 'en',
      voice: failing,
    };
    expect(await composeSharedGroupLine(db.database, input)).toEqual({
      send: false,
      fallback: 'model_failed',
    });
    await composeSharedGroupLine(db.database, input);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site shared_group_unwritten.');
    expect(posted[0]).toContain('kind intro.');
    expect(posted[0]).toContain('fallback model_failed.');
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits.map((row) => row.action)).toEqual(['group_line_unsent', 'group_line_unsent']);
  }, 30_000);

  it('a group plan text no model could write pages group_plan_unwritten and audits', async () => {
    stubWebhook();
    const { familyId } = await seedFamily(db.database, 'Birch Family');
    const ports = productionGroupPlanReportPorts(db.database);
    const plan = {
      familyId,
      familyEventId: '00000000-0000-4000-8000-000000000001',
      placedByActionId: '00000000-0000-4000-8000-000000000002',
      change: 'moved',
    } as unknown as GroupPlan;
    await ports.unsent(plan);
    await ports.unsent(plan);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toBe('Hale: ops page. site group_plan_unwritten. change moved.');
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits.map((row) => row.action)).toEqual([
      'group_plan.line_unsent',
      'group_plan.line_unsent',
    ]);
  }, 30_000);
});

describe('the intake health line', () => {
  it('a health turn with no line writer pages intake_health_unwritten and sends nothing', async () => {
    stubWebhook();
    const phone = '+15555550177';
    const { familyId, parentUserId } = await seedFamily(db.database, 'Cedar Family');
    await db.database.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(phone),
      phoneEncrypted: encryptString(phone),
      state: 'awaiting_ladder',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: null },
          transcript: [{ direction: 'in', body: 'hi', at: BASE.toISOString() }],
          ladderNext: 'turtle',
        }),
      ),
      createdAt: BASE,
      familyId,
      userId: parentUserId,
    });
    const transport = new FakeTransport();
    const turn: IntakeDeps = {
      transport,
      threadMessage: async () => 'conv-1',
      openQuestions: fakeNoOpenQuestions,
      extractor: new FakeExtractor([{ children: [], postalCode: null }]),
      intentReader: new FakeIntentReader([
        { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
      ]),
      radar: {
        async compose() {
          throw new Error('a health turn never reaches the radar');
        },
      },
      answerComposer: new FakeAnswerComposer({ status: 'safety' }),
      identityAsk: new FakeIdentityAsk(),
      limiter: new FakeRateLimiter(() => Date.now()),
      optOutReader: {
        read: async () => ({ intent: 'none', confirmation: '', language: 'en' }),
      },
      now: new Date(),
    };

    await handleInboundSms(db.database, transport.inbound(phone, 'words read as health'), turn);

    expect(transport.bodies()).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site intake_health_unwritten.');
    expect(posted[0]).toContain('reason writer_absent.');
    expect(posted[0]).not.toContain('5555550177');
  }, 30_000);
});

describe('the opt-out hold', () => {
  /** An over-limit turn: read once, the hold settled, nothing else run or paged. */
  function overLimitTurn(reading: OptOutReading | null, fault: 'hold' | 'settled'): IntakeDeps {
    const refuse = async () => {
      throw new Error('hold store down');
    };
    return {
      transport: new FakeTransport(),
      threadMessage: async () => 'conv-1',
      openQuestions: fakeNoOpenQuestions,
      extractor: new FakeExtractor([]),
      intentReader: new FakeIntentReader([]),
      radar: {
        async compose() {
          throw new Error('an over-limit turn never reaches the radar');
        },
      },
      answerComposer: new FakeAnswerComposer({ status: 'safety' }),
      identityAsk: new FakeIdentityAsk(),
      limiter: { check: async () => ({ allowed: false, retryAfterSec: 60, firstDenied: false }) },
      optOutReader: { read: async () => reading },
      optOutHold: {
        hold: fault === 'hold' ? refuse : async () => {},
        settled: fault === 'settled' ? refuse : async () => {},
      },
      now: new Date(),
    };
  }

  it('a failed read whose hold did not land pages opt_out_hold_unwritten', async () => {
    stubWebhook();
    const turn = overLimitTurn(null, 'hold');

    const result = await handleInboundSms(
      db.database,
      (turn.transport as FakeTransport).inbound('+15555550178', 'words nobody read'),
      turn,
    );

    expect(result.status).toBe('rate_limited');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('site opt_out_hold_unwritten.');
    expect(posted[0]).not.toContain('5555550178');
  }, 30_000);

  it('a read whose release did not land pages nobody: the row is read again', async () => {
    stubWebhook();
    const turn = overLimitTurn({ intent: 'none', confirmation: '', language: 'en' }, 'settled');

    const result = await handleInboundSms(
      db.database,
      (turn.transport as FakeTransport).inbound('+15555550179', 'words read fine'),
      turn,
    );

    expect(result.status).toBe('rate_limited');
    expect(posted).toEqual([]);
  }, 30_000);
});

function alert(inboundId: string, over: Partial<CrisisUnanswered> = {}): CrisisUnanswered {
  return {
    kind: 'mental',
    where: 'intake crisis',
    reason: 'write_failed',
    writes: 2,
    inboundId,
    familyId: null,
    parentUserId: null,
    ...over,
  };
}

describe('crisis claims', () => {
  it('a crisis page carries its claim id as the one reference', async () => {
    expect(await noteCrisisUnanswered(db.database, alert('pm-ref'), { post, now: BASE })).toBe(
      'paged',
    );
    const [claim] = await claims(CRISIS_UNANSWERED_PAGE_ROUTE);
    expect(posted).toEqual([
      `Hale: URGENT crisis flagged, no reply sent. kind mental. where intake_crisis. reason write_failed. writes 2. ref ${claim?.id}.`,
    ]);
    expect(claim?.windowStart).toEqual(BASE);
  });

  it('crises with no provider id are never deduped against each other', async () => {
    const pager = failurePageCrisisPager(db.database, { post, now: BASE });
    expect(await logCrisisUnanswered(pager, alert(''))).toBe('paged');
    expect(await logCrisisUnanswered(pager, alert(''))).toBe('paged');
    await pageFailureAlerts(db.database, { post, now: new Date(BASE.getTime() + 5 * 60_000) });
    // One post per crisis, not one per record + page.
    expect(posted).toHaveLength(2);
    const rows = await claims(CRISIS_UNANSWERED_PAGE_ROUTE);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.count === ALERTED_COUNT)).toBe(true);
  });

  it('positive control: two crises with one provider id page once', async () => {
    const pager = failurePageCrisisPager(db.database, { post, now: BASE });
    expect(await logCrisisUnanswered(pager, alert('pm-1'))).toBe('paged');
    expect(await logCrisisUnanswered(pager, alert('pm-1'))).toBe('already_paged');
    await pageFailureAlerts(db.database, { post, now: new Date(BASE.getTime() + 5 * 60_000) });
    expect(posted).toHaveLength(1);
  });

  it('a direct page with no provider id still goes, without a claim', async () => {
    expect(await noteCrisisUnanswered(db.database, alert(''), { post, now: BASE })).toBe('paged');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('ref none.');
    expect(await claims(CRISIS_UNANSWERED_PAGE_ROUTE)).toEqual([]);
  });

  it('two deliveries of one inbound that failed differently page once', async () => {
    const outcomes = await Promise.all([
      noteCrisisUnanswered(db.database, alert('pm-race'), { post, now: BASE }),
      noteCrisisUnanswered(db.database, alert('pm-race', { reason: 'no_writer', writes: 0 }), {
        post,
        now: BASE,
      }),
    ]);
    expect(outcomes.sort()).toEqual(['already_paged', 'paged']);
    expect(posted).toHaveLength(1);
    expect(await claims(CRISIS_UNANSWERED_PAGE_ROUTE)).toHaveLength(1);
  });

  it('retention deletes a paged crisis claim past the lookback and keeps the rest', async () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    const days = (n: number) => new Date(now.getTime() - n * 24 * HOUR);
    const key = (c: string) => `${c.repeat(32)}:mental:intake_crisis:write_failed:2`;
    await db.database.insert(schema.rateLimits).values([
      { route: CRISIS_UNANSWERED_PAGE_ROUTE, identifier: key('a'), windowStart: days(8), count: 1 },
      {
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        identifier: key('b'),
        windowStart: new Date(now.getTime() - HOUR),
        count: 1,
      },
      { route: CRISIS_UNANSWERED_PAGE_ROUTE, identifier: key('c'), windowStart: days(8), count: 0 },
      {
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        identifier: key('d'),
        windowStart: CLAIM_EPOCH,
        count: 1,
      },
    ]);

    await pageFailureAlerts(db.database, { post, now });

    const crisis = await claims(CRISIS_UNANSWERED_PAGE_ROUTE);
    expect(crisis.map((row) => [row.identifier.slice(0, 1), row.count]).sort()).toEqual([
      ['b', 1],
      ['c', 1],
    ]);
    // The owed one was paged, not deleted.
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain(`ref ${crisis.find((row) => row.identifier.startsWith('c'))?.id}.`);
  });

  it('retention keeps a crisis claim and reply mark whose text is still held', async () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    const old = new Date(now.getTime() - 8 * 24 * HOUR);
    // The key the header documents: the first 32 hex of sha256(provider message id).
    const keyOf = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
    const claim = (id: string) => `${keyOf(id)}:mental:late_read:write_failed:2`;
    await db.database.insert(schema.optOutHeldMessages).values({
      providerMessageId: 'pm-still-held',
      phoneHash: 'hash-held',
      heldAt: old,
      nextReadAt: new Date(now.getTime() + HOUR),
    });
    await db.database.insert(schema.rateLimits).values([
      {
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        identifier: claim('pm-still-held'),
        windowStart: old,
        count: 1,
      },
      {
        route: CRISIS_UNANSWERED_PAGE_ROUTE,
        identifier: claim('pm-gone'),
        windowStart: old,
        count: 1,
      },
      {
        route: CRISIS_ANSWERED_ROUTE,
        identifier: keyOf('pm-still-held'),
        windowStart: old,
        count: 1,
      },
      { route: CRISIS_ANSWERED_ROUTE, identifier: keyOf('pm-gone'), windowStart: old, count: 1 },
    ]);

    await pageFailureAlerts(db.database, { post, now });

    expect((await claims(CRISIS_UNANSWERED_PAGE_ROUTE)).map((row) => row.identifier)).toEqual([
      claim('pm-still-held'),
    ]);
    // Positive control: the same age with no held text goes.
    expect((await claims(CRISIS_ANSWERED_ROUTE)).map((row) => row.identifier)).toEqual([
      keyOf('pm-still-held'),
    ]);
  });

  it('retention deletes an ops page claim past the lookback and keeps a fresh one', async () => {
    const now = new Date('2026-11-20T12:00:00.000Z');
    await db.database.insert(schema.rateLimits).values([
      {
        route: OPS_PAGE_ROUTE,
        identifier: 'opt_out_unread',
        windowStart: new Date(now.getTime() - 8 * 24 * HOUR),
        count: 1,
      },
      {
        route: OPS_PAGE_ROUTE,
        identifier: 'spoken_line_unwritten',
        windowStart: new Date(now.getTime() - 10 * 60_000),
        count: 1,
      },
    ]);
    await pageFailureAlerts(db.database, { post, now });
    const ops = await db.database
      .select({ identifier: schema.rateLimits.identifier })
      .from(schema.rateLimits)
      .where(and(eq(schema.rateLimits.route, OPS_PAGE_ROUTE)));
    expect(ops).toEqual([{ identifier: 'spoken_line_unwritten' }]);
  });
});
