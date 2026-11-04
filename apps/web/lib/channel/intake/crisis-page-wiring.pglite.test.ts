import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaidLineWriter } from '~/lib/channel/voice/said-line';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import {
  CRISIS_UNANSWERED_AUDIT_ACTION,
  CRISIS_UNANSWERED_PAGE_ROUTE,
} from '~/lib/monitoring/failure-page';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { NO_TEEN_UNLOCKS } from '~/lib/teen-access';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { trailVerb } from '~/lib/trail/verbs';
import {
  FakeAnswerComposer,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
} from './fakes';
import { type IntakeDeps, handleInboundSms } from './machine';
import { FakeTransport } from './transport';

/**
 * The production wiring: no `crisisPager` in the deps, so the default (the real
 * failure-page pager on this turn's database) is the one that runs. Only the network
 * is faked, at the Slack webhook.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+15555550123';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const WEBHOOK = 'https://hooks.example.test/ops';

function deps(transport: FakeTransport): IntakeDeps {
  return {
    transport,
    threadMessage: async () => 'conv-1',
    openQuestions: fakeNoOpenQuestions,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: {
      async compose() {
        throw new Error('a crisis turn never reaches the radar');
      },
    },
    answerComposer: fakeSilentAnswerComposer,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
}

describe('a crisis with no reply pages #ops through the default pager', () => {
  let db: TestDb;
  let posted: string[];

  beforeEach(async () => {
    db = await createTestDb();
    process.env.APP_ENCRYPTION_KEY = KEY;
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
    posted = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
      return new Response('ok', { status: 200 });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  }, 30_000);

  afterEach(async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.close();
  });

  async function crisisClaims() {
    return db.database
      .select({ identifier: schema.rateLimits.identifier, count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .where(eq(schema.rateLimits.route, CRISIS_UNANSWERED_PAGE_ROUTE));
  }

  it('a first text read as a crisis, with no writer, pages before any family exists', async () => {
    const transport = new FakeTransport();
    const turn = deps(transport);
    turn.optOutReader = {
      read: async () => ({ intent: 'crisis_emergency', confirmation: '', language: 'en' }),
    };
    await handleInboundSms(db.database, transport.inbound(PHONE, 'help'), turn);

    expect(transport.bodies()).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('kind emergency.');
    expect(posted[0]).toContain('reason no_writer.');
    const claims = await crisisClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.identifier).toMatch(/^[0-9a-f]{32}:emergency:intake_crisis:no_writer:0$/);
    expect(claims[0]?.count).toBe(1);
  }, 30_000);

  it("a reply that fails twice for a family pages and writes the family's audit row", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Wren Family');
    await db.database.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      phoneEncrypted: encryptString(PHONE),
      state: 'awaiting_ladder',
      dataEncrypted: encryptString(
        JSON.stringify({
          collected: { children: [], postalCode: null },
          transcript: [{ direction: 'in', body: 'hi', at: NOW.toISOString() }],
          ladderNext: 'turtle',
        }),
      ),
      createdAt: NOW,
      familyId,
      userId: parentUserId,
    });
    const transport = new FakeTransport();
    const turn = deps(transport);
    turn.optOutReader = {
      read: async () => ({ intent: 'none', confirmation: '', language: 'en' }),
    };
    turn.answerComposer = new FakeAnswerComposer({ status: 'mental_crisis' });
    let writes = 0;
    const writer: SaidLineWriter = {
      async write() {
        writes += 1;
        return null;
      },
    };
    turn.saidLine = writer;
    await handleInboundSms(db.database, transport.inbound(PHONE, 'words read as none'), turn);

    expect(writes).toBe(2);
    expect(transport.bodies()).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('kind mental.');
    expect(posted[0]).toContain('where intake_answer_crisis.');
    const claims = await crisisClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.count).toBe(1);
    const audit = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, CRISIS_UNANSWERED_AUDIT_ACTION));
    expect(audit).toEqual([
      {
        after: {
          kind: 'mental',
          where: 'intake answer crisis',
          reason: 'write_failed',
          writes: 2,
        },
      },
    ]);

    // History leaves it out: the household's shared receipts never show one parent's
    // crisis. The right-to-access export keeps it (positive control).
    const sentence = trailVerb(CRISIS_UNANSWERED_AUDIT_ACTION).sentence;
    expect(sentence).not.toBe('recorded an update');
    const history = await loadTrailForFamily(db.database, familyId);
    expect(history.some((row) => row.summary.includes(sentence))).toBe(false);
    const exported = await loadTrailForFamily(db.database, familyId, NO_TEEN_UNLOCKS, {
      includeInternal: true,
    });
    expect(exported.filter((row) => row.summary.includes(sentence))).toHaveLength(1);
  }, 30_000);
});
