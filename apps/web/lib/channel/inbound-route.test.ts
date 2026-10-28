import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import {
  type FakeDb,
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
  makeFakeDb,
} from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { scriptedFriendVoice } from '~/lib/channel/intake/scripted-friend-voice.fixture';
import { SCRIPTED_STOP_CONFIRMATION } from '~/lib/channel/intake/scripted-opt-out-reader.fixture';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LINQ_TYPING_SHOW_DELAY_MS } from '~/lib/channel/linq/presence';
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
  /** The Linq bind each intake build received. Undefined is SMS. */
  linqBinds: Array<{ chatId: string; replyToMessageId?: string | null } | undefined>;
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
    friendVoice: scriptedFriendVoice,
    // A FakeDb has no `conversations` to resolve, and what this file pins is not the
    // thread — the machine's own suite owns that (intake/machine.test.ts).
    threadMessage: async () => 'conv-1',
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
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
    linqBinds: [],
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
      intake: (
        inboundTransport?: string,
        linq?: { chatId: string; replyToMessageId?: string | null },
      ) => {
        state.intakeBuilds += 1;
        h.intakeBuilds = state.intakeBuilds;
        if (inboundTransport !== undefined) h.intakeTransports.push(inboundTransport);
        h.linqBinds.push(linq);
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

const PHOTO = {
  kind: 'image' as const,
  url: 'https://cdn.example/flyer.jpg',
  mime: 'image/jpeg',
};
const VIDEO = { kind: 'video' as const, url: 'https://cdn.example/clip.mp4', mime: 'video/mp4' };

function inbound(
  overrides: Partial<{
    body: string;
    providerId: string;
    from: string;
    budget: 'chat';
    media: ReadonlyArray<{
      kind: 'image' | 'video' | 'file';
      url: string | null;
      mime: string | null;
    }>;
  }> = {},
) {
  return {
    from: overrides.from ?? PHONE,
    body: overrides.body ?? 'hi',
    providerId: overrides.providerId ?? 'SM11111111111111111111111111111111',
    receivedAt: NOW,
    ...(overrides.budget ? { budget: overrides.budget } : {}),
    ...(overrides.media ? { media: overrides.media } : {}),
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
  it('hands STOP to the machine, which revokes and confirms — a photo does not divert it', async () => {
    const h = harness();
    enrol(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'STOP', media: [PHOTO] }));

    expect(outcome).toBe('intake');
    expect(h.transport.bodies()).toEqual([SCRIPTED_STOP_CONFIRMATION]);
    expect(h.transport.bodies().join('\n')).not.toContain("I can't read attachments");
    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('hands an enrolled photo to the coach and stores the part, with no fixed line', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'the flyer', media: [PHOTO] }));

    expect(outcome).toBe('handed_off');
    expect(h.transport.sent).toHaveLength(0);
    expect(h.jobs).toHaveLength(1);
    const row = h.fake.rows(schema.channelMessages).find((r) => r.direction === 'in');
    expect(row).toMatchObject({
      familyId,
      parentUserId: userId,
      body: 'the flyer',
      inboundMedia: [PHOTO],
    });
    expect(row?.replySource).toBeUndefined();
  });

  it('stores the door\'s group bit on the inbound row and the job (VIL-463)', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    await routeInboundText(h.deps, {
      ...inbound({ providerId: 'msg-1to1' }),
      transport: 'imessage',
      chatId: 'chat-1',
      isGroup: false,
    });
    await routeInboundText(h.deps, inbound({ providerId: 'msg-unsaid' }));

    const rows = h.fake.rows(schema.channelMessages).filter((r) => r.direction === 'in');
    expect(rows.find((r) => r.providerMessageId === 'msg-1to1')?.inGroup).toBe(false);
    // The door did not say: stored as unknown, never as a 1:1 text.
    expect(rows.find((r) => r.providerMessageId === 'msg-unsaid')?.inGroup).toBeNull();
    expect(h.jobs.map((j) => j.in_group)).toEqual([false, undefined]);
  });

  it('hands a video to the coach the same way, so the model can write the reply', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: '', media: [VIDEO] }));

    expect(outcome).toBe('handed_off');
    expect(h.transport.sent).toHaveLength(0);
    const row = h.fake.rows(schema.channelMessages).find((r) => r.direction === 'in');
    expect(row?.inboundMedia).toEqual([VIDEO]);
  });

  it('greets a stranger who sent only a photo, and does not send a fixed attachment line', async () => {
    const h = harness();

    const outcome = await routeInboundText(h.deps, inbound({ body: '', media: [PHOTO] }));

    expect(outcome).toBe('intake');
    expect(h.jobs).toHaveLength(0);
    expect(h.transport.bodies().join('\n')).not.toContain("I can't read attachments");
    expect(h.fake.rows(schema.channelMessages).some((r) => r.replySource === 'fixed')).toBe(false);
  });

  it('spends the same inbound budget on a photo as on a text', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check');

    await routeInboundText(h.deps, inbound({ body: '', media: [PHOTO] }));

    expect(spy).toHaveBeenCalledWith(
      phoneBlindIndex(PHONE),
      'sms-inbound',
      expect.objectContaining({ limit: 30 }),
    );
  });

  it('sends nothing to a revoked number, photo or not', async () => {
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

    const outcome = await routeInboundText(h.deps, inbound({ body: '', media: [PHOTO] }));

    expect(outcome).toBe('ignored');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('stays silent when a photo is over the inbound limit', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    vi.spyOn(limiter, 'check').mockResolvedValue({ allowed: false, retryAfterSec: 60 });

    const outcome = await routeInboundText(h.deps, inbound({ body: '', media: [PHOTO] }));

    expect(outcome).toBe('rate_limited');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('does not spend the sender budget on a group photo the door already charged', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check').mockResolvedValue({ allowed: false, retryAfterSec: 60 });

    const outcome = await routeInboundText(
      h.deps,
      inbound({ body: '', budget: 'chat', media: [PHOTO] }),
    );

    expect(outcome).toBe('intake');
    expect(spy).not.toHaveBeenCalled();
    expect(h.transport.bodies().join('\n')).not.toContain("I can't read attachments");
  });

  it('drops a photo from a number we cannot parse', async () => {
    const h = harness();

    const outcome = await routeInboundText(
      h.deps,
      inbound({ from: 'not-a-number', body: '', media: [PHOTO] }),
    );

    expect(outcome).toBe('ignored');
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

  it("carries the door's own group bit on the job while group onboarding v2 is dark", async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    const queued = async (isGroup: boolean) => {
      const h = harness();
      enrol(h.fake);
      closeIntake(h.fake);
      await routeInboundText(h.deps, {
        ...inbound({ body: 'can you move swimming to Thursday?' }),
        transport: 'imessage',
        chatId: 'chat-1',
        isGroup,
      });
      return h.jobs;
    };

    expect((await queued(true)).map((queuedJob) => queuedJob.in_group)).toEqual([true]);
    expect((await queued(false)).map((queuedJob) => queuedJob.in_group)).toEqual([false]);
  });

  /**
   * A door that was not told whether the chat is a group says nothing on the job. It used
   * to say `false`, so a text from a chat Linq did not describe was queued as a 1:1 text
   * and the router's `group_unknown` skip could never fire.
   */
  it('queues no group bit for a text whose door did not say', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    await routeInboundText(h.deps, {
      ...inbound({ body: 'can you move swimming to Thursday?' }),
      transport: 'imessage',
      chatId: 'chat-1',
    });

    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]).not.toHaveProperty('in_group', false);
    expect(h.jobs[0]?.in_group).toBeUndefined();
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

    const outcome = await routeInboundText(h.deps, inbound({ body: 'hello again' }));

    // The handoff resolves through `resolveVerifiedChannelByPhone`, which never returns
    // a revoked row — so a number that pressed STOP is structurally unable to become a
    // C1 conversation. (What the machine does with such a text is M2's call, not A3's;
    // see the PR's live-config note on the former Twilio Advanced Opt-Out.)
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

      const outcome = await routeInboundText(h.deps, inbound({ body: "what's on today?" }));

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

      const outcome = await routeInboundText(h.deps, inbound({ body: "what's on today?" }));

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

    const outcome = await routeInboundText(h.deps, inbound({ body: 'hello' }));

    expect(outcome).toBe('not_a_parent');
    expect(h.jobs).toHaveLength(0);
  });

  it('hands off a co_parent, not only the primary parent', async () => {
    const h = harness();
    enrol(h.fake, 'co_parent');
    closeIntake(h.fake);

    expect(await routeInboundText(h.deps, inbound({ body: 'move swimming' }))).toBe('handed_off');
  });

  it('is idempotent on a webhook RETRY — one ledger row, one job', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const first = await routeInboundText(h.deps, inbound({ body: 'move swimming' }));
    const retry = await routeInboundText(h.deps, inbound({ body: 'move swimming' }));

    expect(first).toBe('handed_off');
    expect(retry).toBe('duplicate');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
  });

  /**
   * The hand-off marker exists so that "have we seen this message" and "was it handed to
   * C1" stop being the same question answered by the same row. Before it, a parent's
   * "yes, book it" whose enqueue failed after the ledger row committed was swallowed
   * forever: Linq's retry found the row, said 'duplicate', answered 200, and the audit
   * trail asserted the message had been received AND handled.
   */
  it('marks the row handed off once the job is really enqueued', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    await routeInboundText(h.deps, inbound({ body: 'move swimming' }));

    const [row] = h.fake.rows(schema.channelMessages);
    expect(row?.handedOffAt).toEqual(NOW);
  });

  /**
   * A failed enqueue is an OUTCOME, not an exception that escapes (rule #11). Letting it
   * throw made the route 500, which made Linq retry, and the retry could only ever lose
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

    const outcome = await routeInboundText(h.deps, inbound({ body: 'yes, book it' }));

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

    await routeInboundText(h.deps, inbound({ body: 'Maya has an appointment at 4' }));

    expect(h.errors).toHaveLength(1);
    const line = JSON.stringify(h.errors[0]);
    expect(line).toContain('SM11111111111111111111111111111111');
    expect(line).toContain('pool exhausted');
    // Rule #1: the operator line names the message, never its contents or the number.
    expect(line).not.toContain('Maya');
    expect(line).not.toContain(PHONE);
  });

  /**
   * The P2 race. Linq resends when the handler exceeds its 15s budget, and the resend
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
      routeInboundText(h.deps, inbound({ body: 'yes, book it' })),
      routeInboundText(h.deps, inbound({ body: 'yes, book it' })),
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
    );

    expect(outcome).toBe('handed_off_canary');
    expect(h.jobs).toHaveLength(1);
  });

  it('leaves a real household on handed_off when the body is the probe word', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeInboundText(h.deps, inbound({ body: 'CANARY' }));

    expect(outcome).toBe('handed_off');
  });

  it.each(['what can you do', 'set me up'])(
    'hands an enrolled parent asking "%s" to the coach, with the cold-start ladder on',
    async (body) => {
      vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
      const h = harness();
      const { familyId, userId } = enrol(h.fake);
      closeIntake(h.fake);

      const outcome = await routeInboundText(h.deps, inbound({ body }));

      expect(outcome).toBe('handed_off');
      const message = h.fake
        .rows(schema.channelMessages)
        .find((r) => r.providerMessageId === 'SM11111111111111111111111111111111');
      expect(message).toMatchObject({ familyId, parentUserId: userId, direction: 'in', body });
      expect(h.jobs).toEqual([
        {
          family_id: familyId,
          parent_user_id: userId,
          channel_message_id: message?.id,
          provider_message_id: 'SM11111111111111111111111111111111',
          received_at: NOW.toISOString(),
        },
      ]);
      expect(h.transport.bodies()).toEqual([]);
    },
  );
});

describe('iMessage first-touch door', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not thread a 1:1 reply, and does thread a group reply', async () => {
    const h = harness();
    await routeInboundText(h.deps, {
      ...inbound({ providerId: 'msg-1' }),
      transport: 'imessage',
      chatId: 'chat-1',
      isGroup: false,
    });
    expect(h.linqBinds[0]).toEqual({ chatId: 'chat-1' });
    expect(h.linqBinds[0]).not.toHaveProperty('replyToMessageId');

    const group = harness();
    await routeInboundText(group.deps, {
      ...inbound({ providerId: 'msg-g' }),
      transport: 'imessage',
      chatId: 'chat-group',
      isGroup: true,
    });
    expect(group.linqBinds[0]).toEqual({
      chatId: 'chat-group',
      replyToMessageId: 'msg-g',
    });
  });

  it('starts typing as soon as the inbound arrives and stops when the turn ends', async () => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const h = harness();
    await routeInboundText(h.deps, { ...inbound(), transport: 'imessage', chatId: 'chat-1' });
    const typing = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/typing'));
    expect(typing.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('starts typing when the turn is still working after the delay, and a failure does not drop the reply', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LINQ_API_KEY', '');
    const h = harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intake = h.deps.intake;
    h.deps.intake = (transport, linq) => {
      const built = intake(transport, linq);
      return {
        ...built,
        limiter: {
          check: async () => {
            await gate;
            return { allowed: true, retryAfterSec: 0 };
          },
        },
      };
    };
    const pending = routeInboundText(h.deps, {
      ...inbound(),
      transport: 'imessage',
      chatId: 'chat-1',
    });
    await vi.advanceTimersByTimeAsync(LINQ_TYPING_SHOW_DELAY_MS);
    expect(h.warns.some((call) => String(call[1]).includes('did not start'))).toBe(true);
    release();
    await pending;
    expect(h.transport.bodies().length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });
});

describe('a first text that got no reply', () => {
  beforeEach(() => {
    vi.stubEnv('FIRST_TOUCH_LADDER_ENABLED', 'on');
  });

  function withComposer(h: Harness, compose: () => Promise<{ reply: string }>): void {
    const intake = h.deps.intake('sms');
    intake.friendVoice = { compose };
  }

  it('is counted intake_unsent, never folded into intake', async () => {
    const h = harness();
    withComposer(h, async () => {
      throw new Error('model down');
    });

    const outcome = await routeInboundText(h.deps, inbound());

    expect(outcome).toBe('intake_unsent');
    expect(h.transport.bodies()).toEqual([]);
  });

  it('stays intake when the opening reply was sent', async () => {
    const h = harness();
    withComposer(h, async () => ({ reply: "Hey, it's Hale. What's your postal code?" }));

    const outcome = await routeInboundText(h.deps, inbound());

    expect(outcome).toBe('intake');
    expect(h.transport.bodies()).toHaveLength(1);
  });
});

/**
 * Sloane, #868: an opt-out stops ALL texting at once. Structural only — no reply
 * copy is matched. After the opt-out the channel row is revoked, the proactive gate
 * refuses every class, and no onboarding or group turn from that number sends.
 */
describe('an opt-out stops all outbound texting immediately', () => {
  it('revokes the channel, holds every proactive class, and sends nothing after the confirmation', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);

    await routeInboundText(h.deps, inbound({ body: 'STOP', providerId: 'SMstop' }));

    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
    // At most one confirmation, in the model's or the carrier's words.
    const afterStop = h.transport.bodies().length;
    expect(afterStop).toBeLessThanOrEqual(1);

    // Onboarding turn after the opt-out: nothing goes out.
    await routeInboundText(
      h.deps,
      inbound({ body: "what's on this weekend?", providerId: 'SMafter1' }),
    );
    // Group turn from the same number: nothing goes out.
    await routeInboundText(h.deps, {
      ...inbound({ body: 'hey all', providerId: 'SMafter2', budget: 'chat' }),
      isGroup: true,
    });
    expect(h.transport.bodies().length).toBe(afterStop);

    // Proactive: a revoked channel is not enrolled, so every class is held.
    const { assertProactiveSendAllowed } = await import('./outbound-gate');
    const ports = {
      // Enrolment follows the revocation the STOP turn actually wrote.
      channelEnrolled: async () => revoked.length === 0,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () => 'America/Toronto',
    };
    for (const kind of ['nudge', 'plan_checkin', 'calendar_reminder'] as const) {
      const verdict = await assertProactiveSendAllowed(
        { familyId, parentUserId: userId, kind: kind as never, now: NOW, urgent: true },
        ports,
      );
      expect(verdict.allowed).toBe(false);
    }
  });

  it('the model reads an opt-out in any wording, revokes, and its own confirmation is the only text', async () => {
    const h = harness();
    enrol(h.fake);
    const said: string[] = [];
    const intake = h.deps.intake('sms');
    intake.optOutReader = {
      read: async ({ text }) => {
        said.push(text);
        return { intent: 'stop', confirmation: `model:${text.length}` };
      },
    };

    await routeInboundText(h.deps, inbound({ body: 'pls leave me alone', providerId: 'SMx1' }));

    expect(said).toEqual(['pls leave me alone']);
    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
    // The one confirmation is exactly what the reader wrote — nothing fixed is added.
    expect(h.transport.bodies()).toEqual(['model:18']);
  });

  it('an empty model confirmation still revokes and sends nothing', async () => {
    const h = harness();
    enrol(h.fake);
    h.deps.intake('sms').optOutReader = {
      read: async () => ({ intent: 'stop', confirmation: '' }),
    };

    await routeInboundText(h.deps, inbound({ body: 'done with this', providerId: 'SMx2' }));

    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
    expect(h.transport.bodies()).toEqual([]);
  });
});
