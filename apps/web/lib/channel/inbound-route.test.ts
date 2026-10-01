import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { STOP_ACK } from '~/lib/channel/intake/copy';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  type FakeDb,
  fakeAckComposer,
  fakeRadar,
  fakeNoOpenQuestions,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  type ChannelMessageReceivedJob,
  type InboundRouteDeps,
  type InboundRouteOutcome,
  routeInboundText,
} from './inbound-route';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

interface Harness {
  fake: FakeDb;
  transport: FakeTransport;
  jobs: ChannelMessageReceivedJob[];
  /** Every operator line the webhook wrote, as its argument arrays. */
  errors: unknown[][];
  /** The warn lines — today only the unrecognised-`OptOutType` one (VIL-348). */
  warns: unknown[][];
  /** The routed-outcome lines — the shell's one info line per authentic request. */
  infos: unknown[][];
  /** Every outcome the shell counted, in order (rule #11's rate). */
  counted: InboundRouteOutcome[];
  deps: InboundRouteDeps;
  intakeBuilds: number;
  /** The transport each intake build was told the message arrived on. */
  intakeTransports: string[];
}

function harness(): Harness {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const jobs: ChannelMessageReceivedJob[] = [];
  const errors: unknown[][] = [];
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  const counted: InboundRouteOutcome[] = [];
  const state = { intakeBuilds: 0 };
  const intake: IntakeDeps = {
    transport,
    // A FakeDb has no `conversations` to resolve, and what this file pins is not the
    // thread — the machine's own suite owns that (intake/machine.test.ts).
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    ackComposer: fakeAckComposer,
    answerComposer: fakeSilentAnswerComposer,
    openQuestions: fakeNoOpenQuestions,
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
  const h: Harness = {
    fake,
    transport,
    jobs,
    errors,
    warns,
    infos,
    counted,
    intakeBuilds: 0,
    intakeTransports: [],
    deps: {
      database: fake.db,
      log: {
        info: (...args: unknown[]) => {
          infos.push(args);
        },
        warn: (...args: unknown[]) => {
          warns.push(args);
        },
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      countOutcome: async (outcome) => {
        counted.push(outcome);
      },
      intake: (inboundTransport?: string) => {
        state.intakeBuilds += 1;
        h.intakeBuilds = state.intakeBuilds;
        if (inboundTransport !== undefined) h.intakeTransports.push(inboundTransport);
        return intake;
      },
      enqueue: async (job) => {
        jobs.push(job);
      },
      now: () => NOW,
    },
  };
  return h;
}

/** An enrolled household member whose intake is finished. Defaults to a parent — the
 * family C1's handoff is for; `role` drives the authorization tests. */
function enrol(
  fake: FakeDb,
  role = 'primary_parent',
  phone = PHONE,
): { familyId: string; userId: string } {
  const familyId = '00000000-0000-4000-8000-0000000000f1';
  const userId = '00000000-0000-4000-8000-0000000000u1';
  fake.db.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  } as never);
  fake.db.insert(schema.familyMembers).values({ userId, familyId, role } as never);
  return { familyId, userId };
}

/** A family whose intake conversation is over, so the machine defers to A3. */
function closeIntake(fake: FakeDb): void {
  fake.db.insert(schema.smsIntakeSessions).values({
    phoneHash: phoneBlindIndex(PHONE),
    state: 'complete',
    closedAt: NOW,
  } as never);
}

function inbound(overrides: Partial<{ body: string; providerId: string; from: string }> = {}) {
  return {
    from: overrides.from ?? PHONE,
    body: overrides.body ?? 'hi',
    providerId: overrides.providerId ?? 'SM11111111111111111111111111111111',
    receivedAt: NOW,
  };
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('routing', () => {
  it('hands STOP to the machine, which revokes and confirms — media does not divert it', async () => {
    const h = harness();
    enrol(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'STOP' }), 1);

    expect(outcome).toBe('intake');
    // The CASL path ran, not the attachment notice.
    expect(h.transport.bodies()).toEqual([STOP_ACK]);
    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('answers an MMS with the attachment line and never enqueues it', async () => {
    const h = harness();

    const outcome = await routeInboundText(h.deps, inbound({ body: '' }), 2);

    expect(outcome).toBe('media_unsupported');
    expect(h.transport.bodies()[0]).toContain("I can't read attachments over text yet");
    expect(h.jobs).toHaveLength(0);
  });

  it('ledgers the attachment line it texts an enrolled number (rule #6)', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: '' }), 1);

    expect(outcome).toBe('media_unsupported');
    const row = h.fake.rows(schema.channelMessages).find((r) => r.direction === 'out');
    expect(row).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'sms',
      category: 'reply',
      status: 'queued',
      replySource: 'fixed',
      body: null,
    });
    expect(row?.providerMessageId).toMatch(/^fake-out-/);
    const audit = h.fake
      .rows(schema.auditLog)
      .find((a) => a.actionTaken === 'sms_reply_sent' && a.targetId === row?.id);
    expect(audit).toBeDefined();
  });

  it("answers a stranger's MMS without a ledger row — no family exists to hold one", async () => {
    const h = harness();

    const outcome = await routeInboundText(h.deps, inbound({ body: '' }), 1);

    // Positive control: the attachment line itself still goes out.
    expect(outcome).toBe('media_unsupported');
    expect(h.transport.sent).toHaveLength(1);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('shares ONE rate-limit budget between the media path and the machine', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check');

    await routeInboundText(h.deps, inbound({ body: '' }), 1);

    expect(spy).toHaveBeenCalledWith(
      phoneBlindIndex(PHONE),
      'sms-inbound',
      expect.objectContaining({ limit: 30 }),
    );
  });

  it('sends NOTHING to a number that unsubscribed, even a friendly attachment line', async () => {
    const h = harness();
    h.fake.db.insert(schema.parentChannels).values({
      userId: '00000000-0000-4000-8000-0000000000u1',
      familyId: '00000000-0000-4000-8000-0000000000f1',
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
      revokedAt: NOW,
    } as never);

    const outcome = await routeInboundText(h.deps, inbound({ body: '' }), 1);

    // An app link to someone who pressed STOP is a CASL breach; it would also be
    // rejected by Twilio (21610) and throw the webhook into a retry loop.
    expect(outcome).toBe('unsubscribed');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('stays silent when the media path is over the limit', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    vi.spyOn(limiter, 'check').mockResolvedValue({ allowed: false, retryAfterSec: 60 });

    const outcome = await routeInboundText(h.deps, inbound({ body: '' }), 1);

    expect(outcome).toBe('rate_limited');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('drops a message from a number we cannot parse', async () => {
    const h = harness();

    const outcome = await routeInboundText(h.deps, inbound({ from: 'not-a-number' }), 1);

    expect(outcome).toBe('invalid_number');
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('handoff to C1', () => {
  it('records a post-intake reply and queues it, with its audit row', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeInboundText(
      h.deps,
      inbound({ body: 'can you move swimming to Thursday?' }),
      0,
    );

    expect(outcome).toBe('handed_off');

    const message = h.fake
      .rows(schema.channelMessages)
      .find((r) => r.providerMessageId === 'SM11111111111111111111111111111111');
    expect(message).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'can you move swimming to Thursday?',
    });

    const audit = h.fake.rows(schema.auditLog).find((r) => r.actionTaken === 'sms_reply_received');
    expect(audit).toMatchObject({ familyId, actor: userId, targetTable: 'channel_messages' });

    expect(h.jobs).toEqual([
      {
        family_id: familyId,
        parent_user_id: userId,
        channel_message_id: message?.id,
        provider_message_id: 'SM11111111111111111111111111111111',
        received_at: NOW.toISOString(),
      },
    ]);
  });

  it('NEVER hands a REVOKED number to C1 — an unsubscribed parent cannot be conversed with', async () => {
    const h = harness();
    h.fake.db.insert(schema.parentChannels).values({
      userId: '00000000-0000-4000-8000-0000000000u1',
      familyId: '00000000-0000-4000-8000-0000000000f1',
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
      revokedAt: NOW,
    } as never);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'hello again' }), 0);

    // The handoff resolves through `resolveVerifiedChannelByPhone`, which never returns
    // a revoked row — so a number that pressed STOP is structurally unable to become a
    // C1 conversation. (What the machine does with such a text is M2's call, not A3's;
    // see the PR's live-config note on Twilio Advanced Opt-Out.)
    expect(outcome).not.toBe('handed_off');
    expect(h.jobs).toHaveLength(0);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it.each(['extended', 'service'])(
    'refuses to hand a %s member off to a household agent, even with a verified channel',
    async (role) => {
      const h = harness();
      enrol(h.fake, role);
      closeIntake(h.fake);

      const outcome = await routeInboundText(h.deps, inbound({ body: "what's on today?" }), 0);

      // These two are the gap M6 does not close: `isCaregiverRole` is FALSE for them, so
      // they fall past the caregiver branch into the parent branch. role-scope.ts gives
      // them an empty scope precisely so they fail closed — a negative check here would
      // have handed them to an agent that answers with household data.
      expect(outcome).toBe('not_a_parent');
      expect(h.jobs).toHaveLength(0);
      expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
    },
  );

  it.each(['grandparent', 'nanny', 'babysitter'])(
    'leaves a %s to M6 and never queues them for C1',
    async (role) => {
      const h = harness();
      enrol(h.fake, role);
      closeIntake(h.fake);

      const outcome = await routeInboundText(h.deps, inbound({ body: "what's on today?" }), 0);

      // The named caregiver roles are caught UPSTREAM: the machine answers with M6's one
      // scoped line, so A3's handoff is never reached. Asserted so a change to either
      // side that let a caregiver into the conversation queue fails here.
      expect(outcome).toBe('intake');
      expect(h.jobs).toHaveLength(0);
    },
  );

  it('refuses a verified channel whose owner has no family_members row at all', async () => {
    const h = harness();
    h.fake.db.insert(schema.parentChannels).values({
      userId: '00000000-0000-4000-8000-0000000000u1',
      familyId: '00000000-0000-4000-8000-0000000000f1',
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: NOW,
    } as never);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'hello' }), 0);

    expect(outcome).toBe('not_a_parent');
    expect(h.jobs).toHaveLength(0);
  });

  it('hands off a co_parent, not only the primary parent', async () => {
    const h = harness();
    enrol(h.fake, 'co_parent');
    closeIntake(h.fake);

    expect(await routeInboundText(h.deps, inbound({ body: 'move swimming' }), 0)).toBe(
      'handed_off',
    );
  });

  it('is idempotent on a webhook RETRY — one ledger row, one job', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const first = await routeInboundText(h.deps, inbound({ body: 'move swimming' }), 0);
    const retry = await routeInboundText(h.deps, inbound({ body: 'move swimming' }), 0);

    expect(first).toBe('handed_off');
    expect(retry).toBe('duplicate');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
  });

  /**
   * The hand-off marker exists so that "have we seen this message" and "was it handed to
   * C1" stop being the same question answered by the same row. Before it, a parent's
   * "yes, book it" whose enqueue failed after the ledger row committed was swallowed
   * forever: Twilio's retry found the row, said 'duplicate', answered 200, and the audit
   * trail asserted the message had been received AND handled.
   */
  it('marks the row handed off once the job is really enqueued', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    await routeInboundText(h.deps, inbound({ body: 'move swimming' }), 0);

    const [row] = h.fake.rows(schema.channelMessages);
    expect(row?.handedOffAt).toEqual(NOW);
  });

  /**
   * A failed enqueue is an OUTCOME, not an exception that escapes (rule #11). Letting it
   * throw made the route 500, which made Twilio retry, and the retry could only ever lose
   * the claim and answer 'duplicate' — so the exception bought a retry that was
   * guaranteed to do nothing while the text went unanswered and unnamed.
   */
  it('NAMES a failed enqueue rather than throwing, and never marks the row handed off', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);
    h.deps.enqueue = async () => {
      throw new Error('pool exhausted');
    };

    const outcome = await routeInboundText(h.deps, inbound({ body: 'yes, book it' }), 0);

    expect(outcome).toBe('enqueue_failed');
    const [row] = h.fake.rows(schema.channelMessages);
    expect(row).toBeDefined();
    // The row is the durable record of the parent's words — it stays. What must NOT be
    // written is the claim that C1 has it, which is the only thing standing between a
    // failed enqueue and a permanently swallowed approval.
    expect(row?.handedOffAt ?? null).toBeNull();
  });

  it('LOGS the failed enqueue with the ids an operator needs and nothing the parent wrote', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);
    h.deps.enqueue = async () => {
      throw new Error('pool exhausted');
    };

    await routeInboundText(h.deps, inbound({ body: 'Maya has an appointment at 4' }), 0);

    expect(h.errors).toHaveLength(1);
    const line = JSON.stringify(h.errors[0]);
    expect(line).toContain('SM11111111111111111111111111111111');
    expect(line).toContain('pool exhausted');
    // Rule #1: the operator line names the message, never its contents or the number.
    expect(line).not.toContain('Maya');
    expect(line).not.toContain(PHONE);
  });


  /**
   * The P2 race. Twilio resends when the handler exceeds its 15s budget, and the resend
   * can land while attempt #1 is still executing. Select-then-insert let both attempts
   * pass the duplicate guard: two ledger rows for one MessageSid, two `sms_reply_received`
   * audit rows, two jobs, and C1 answering one text twice. The unique index makes the
   * INSERT itself the claim — exactly one request can win it.
   */
  it('double-delivery of one MessageSid produces one row, one audit row and one job', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const outcomes = await Promise.all([
      routeInboundText(h.deps, inbound({ body: 'yes, book it' }), 0),
      routeInboundText(h.deps, inbound({ body: 'yes, book it' }), 0),
    ]);

    expect(outcomes.filter((o) => o === 'handed_off')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(1);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
    const replyAudits = h.fake.writes.filter(
      (w) => w.table === schema.auditLog && w.payload.actionTaken === 'sms_reply_received',
    );
    expect(replyAudits).toHaveLength(1);
  });

  it('labels a canary number handed_off_canary, whatever the body says', async () => {
    const h = harness();
    enrol(h.fake, 'primary_parent', CANARY_PHONE_E164);

    const outcome = await routeInboundText(
      h.deps,
      inbound({ body: 'CANARY PING', from: CANARY_PHONE_E164 }),
      0,
    );

    expect(outcome).toBe('handed_off_canary');
    expect(h.jobs).toHaveLength(1);
  });

  it('leaves a real household on handed_off when the body is the probe word', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'CANARY' }), 0);

    expect(outcome).toBe('handed_off');
  });
});
