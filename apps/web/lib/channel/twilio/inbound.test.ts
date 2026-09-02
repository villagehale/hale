import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_ACK } from '~/lib/channel/intake/copy';
import { FakeExtractor, FakeIdentityAsk, FakeIntentReader, type FakeDb, fakeAckComposer, fakeRadar, fakeSilentAnswerComposer, makeFakeDb } from '~/lib/channel/intake/fakes';
import type { IntakeDeps } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import {
  type ChannelMessageReceivedJob,
  type TwilioInboundDeps,
  handleTwilioInboundRequest,
  routeTwilioInbound,
} from './inbound';

/**
 * The webhook, end to end minus the network. The signature is computed here from
 * Twilio's spec (never by the module under test), so a request built by these helpers
 * is exactly what Twilio would send.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const AUTH_TOKEN = 'twilio_auth_token_value';
const APP_URL = 'https://app.villagehale.com';
const INBOUND_URL = `${APP_URL}/api/channels/twilio/inbound`;
const PHONE = '+14165551234';
const NOW = new Date('2026-07-30T12:00:00.000Z');

function configure(): void {
  vi.stubEnv('APP_URL', APP_URL);
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'api_key_secret_value');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');
}

function sign(url: string, params: Record<string, string>): string {
  let base = url;
  for (const key of Object.keys(params).sort()) base += key + params[key];
  return createHmac('sha1', AUTH_TOKEN).update(base, 'utf8').digest('base64');
}

function twilioParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: 'AC00000000000000000000000000000000',
    Body: 'hi',
    From: PHONE,
    MessageSid: 'SM11111111111111111111111111111111',
    NumMedia: '0',
    To: '+14165550000',
    ...overrides,
  };
}

/** A request exactly as Twilio posts it, correctly signed unless told otherwise. */
function twilioRequest(
  params: Record<string, string>,
  options: { signature?: string | null; url?: string } = {},
): Request {
  const url = options.url ?? INBOUND_URL;
  const signature =
    options.signature === undefined ? sign(INBOUND_URL, params) : options.signature;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return new Request(url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

interface Harness {
  fake: FakeDb;
  transport: FakeTransport;
  jobs: ChannelMessageReceivedJob[];
  /** Every operator line the webhook wrote, as its argument arrays. */
  errors: unknown[][];
  deps: TwilioInboundDeps;
  intakeBuilds: number;
  /** The transport each intake build was told the message arrived on. */
  intakeTransports: string[];
}

function harness(): Harness {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const jobs: ChannelMessageReceivedJob[] = [];
  const errors: unknown[][] = [];
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
    identityAsk: new FakeIdentityAsk(),
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
  const h: Harness = {
    fake,
    transport,
    jobs,
    errors,
    intakeBuilds: 0,
    intakeTransports: [],
    deps: {
      database: fake.db,
      log: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
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
  fake.db
    .insert(schema.parentChannels)
    .values({
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
  configure();
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('config gate — the leg is dark until every credential lands', () => {
  it('answers 503 and does NOTHING when Twilio is not configured', async () => {
    vi.unstubAllEnvs();
    const h = harness();

    const res = await handleTwilioInboundRequest(twilioRequest(twilioParams()), h.deps);

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: 'twilio_not_configured' });
    expect(h.fake.writes).toHaveLength(0);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    // Not even the deps were built — no model client, no provider.
    expect(h.intakeBuilds).toBe(0);
  });

  it('answers 503 when the credentials are only HALF present', async () => {
    vi.stubEnv('TWILIO_API_KEY_SECRET', '');
    const h = harness();

    const res = await handleTwilioInboundRequest(twilioRequest(twilioParams()), h.deps);

    expect(res.status).toBe(503);
    expect(h.fake.writes).toHaveLength(0);
  });
});

describe('signature gate — red team', () => {
  it('accepts a genuine Twilio request', async () => {
    const h = harness();
    const res = await handleTwilioInboundRequest(twilioRequest(twilioParams()), h.deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<Response/>');
  });

  it('rejects a FORGED request (no signature at all) with 403 and zero side effects', async () => {
    const h = harness();

    const res = await handleTwilioInboundRequest(
      twilioRequest(twilioParams(), { signature: null }),
      h.deps,
    );

    expect(res.status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    expect(h.intakeBuilds).toBe(0);
  });

  it('rejects a TAMPERED body — a forged STOP for someone else’s number', async () => {
    const h = harness();
    // Signed as an innocent message, then rewritten to STOP in flight.
    const original = twilioParams({ Body: 'hi' });
    const tampered = twilioParams({ Body: 'STOP' });

    const res = await handleTwilioInboundRequest(
      new Request(INBOUND_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': sign(INBOUND_URL, original),
        },
        body: new URLSearchParams(tampered).toString(),
      }),
      h.deps,
    );

    expect(res.status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
    expect(h.transport.sent).toHaveLength(0);
  });

  it('rejects a signature REPLAYED from the status endpoint onto the inbound one', async () => {
    const h = harness();
    const params = twilioParams();

    const res = await handleTwilioInboundRequest(
      twilioRequest(params, {
        signature: sign(`${APP_URL}/api/channels/twilio/status`, params),
      }),
      h.deps,
    );

    expect(res.status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
  });

  it('rejects a request whose Host header claims a different origin', async () => {
    const h = harness();
    const params = twilioParams();

    // Signed for the attacker's own host. Validation rebuilds the URL from APP_URL, so
    // the attacker's host never becomes part of what we verify against.
    const res = await handleTwilioInboundRequest(
      twilioRequest(params, {
        url: 'https://evil.example.com/api/channels/twilio/inbound',
        signature: sign('https://evil.example.com/api/channels/twilio/inbound', params),
      }),
      h.deps,
    );

    expect(res.status).toBe(403);
    expect(h.fake.writes).toHaveLength(0);
  });

  it('rejects a valid-looking signature computed with the wrong token', async () => {
    const h = harness();
    const params = twilioParams();
    let base = INBOUND_URL;
    for (const key of Object.keys(params).sort()) base += key + params[key];
    const wrong = createHmac('sha1', 'not_the_auth_token').update(base, 'utf8').digest('base64');

    const res = await handleTwilioInboundRequest(
      twilioRequest(params, { signature: wrong }),
      h.deps,
    );

    expect(res.status).toBe(403);
  });
});

describe('routing', () => {
  it('hands STOP to the machine, which revokes and confirms — media does not divert it', async () => {
    const h = harness();
    enrol(h.fake);

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: 'STOP' }), 1);

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

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: '' }), 2);

    expect(outcome).toBe('media_unsupported');
    expect(h.transport.bodies()[0]).toContain("I can't read attachments over text yet");
    expect(h.jobs).toHaveLength(0);
  });

  it('shares ONE rate-limit budget between the media path and the machine', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check');

    await routeTwilioInbound(h.deps, inbound({ body: '' }), 1);

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

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: '' }), 1);

    // An app link to someone who pressed STOP is a CASL breach; it would also be
    // rejected by Twilio (21610) and throw the webhook into a retry loop.
    expect(outcome).toBe('unsubscribed');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('stays silent when the media path is over the limit', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    vi.spyOn(limiter, 'check').mockResolvedValue({ allowed: false, retryAfterSec: 60 });

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: '' }), 1);

    expect(outcome).toBe('rate_limited');
    expect(h.transport.sent).toHaveLength(0);
  });

  it('drops a message from a number we cannot parse', async () => {
    const h = harness();

    const outcome = await routeTwilioInbound(h.deps, inbound({ from: 'not-a-number' }), 1);

    expect(outcome).toBe('invalid_number');
    expect(h.transport.sent).toHaveLength(0);
  });
});

describe('handoff to C1', () => {
  it('records a post-intake reply and queues it, with its audit row', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake);
    closeIntake(h.fake);

    const outcome = await routeTwilioInbound(
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

    const audit = h.fake
      .rows(schema.auditLog)
      .find((r) => r.actionTaken === 'sms_reply_received');
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

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: 'hello again' }), 0);

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

      const outcome = await routeTwilioInbound(h.deps, inbound({ body: "what's on today?" }), 0);

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

      const outcome = await routeTwilioInbound(h.deps, inbound({ body: "what's on today?" }), 0);

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

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: 'hello' }), 0);

    expect(outcome).toBe('not_a_parent');
    expect(h.jobs).toHaveLength(0);
  });

  it('hands off a co_parent, not only the primary parent', async () => {
    const h = harness();
    enrol(h.fake, 'co_parent');
    closeIntake(h.fake);

    expect(await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0)).toBe(
      'handed_off',
    );
  });

  it('is idempotent on a webhook RETRY — one ledger row, one job', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);

    const first = await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0);
    const retry = await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0);

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

    await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0);

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

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: 'yes, book it' }), 0);

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

    await routeTwilioInbound(h.deps, inbound({ body: 'Maya has an appointment at 4' }), 0);

    expect(h.errors).toHaveLength(1);
    const line = JSON.stringify(h.errors[0]);
    expect(line).toContain('SM11111111111111111111111111111111');
    expect(line).toContain('pool exhausted');
    // Rule #1: the operator line names the message, never its contents or the number.
    expect(line).not.toContain('Maya');
    expect(line).not.toContain(PHONE);
  });

  /**
   * The webhook still answers Twilio 200. A 5xx here asks for a redelivery that the claim
   * index guarantees is a no-op, and burns the provider's retry budget on it; the row left
   * unmarked is the re-drive request, and the reconciler is who reads it.
   */
  it('still answers Twilio an empty TwiML 200 when the enqueue failed', async () => {
    const h = harness();
    enrol(h.fake);
    closeIntake(h.fake);
    h.deps.enqueue = async () => {
      throw new Error('pool exhausted');
    };

    const res = await handleTwilioInboundRequest(twilioRequest(twilioParams()), h.deps);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('<Response/>');
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
      routeTwilioInbound(h.deps, inbound({ body: 'yes, book it' }), 0),
      routeTwilioInbound(h.deps, inbound({ body: 'yes, book it' }), 0),
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
});

describe('privacy (rule #1)', () => {
  it('writes no phone number and no message body to the server log', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const h = harness();
    enrol(h.fake);
    const secret = 'Maya has an appointment at 4';

    await handleTwilioInboundRequest(
      twilioRequest(twilioParams({ Body: secret })),
      h.deps,
    );
    // …and on the rejected path too.
    await handleTwilioInboundRequest(
      twilioRequest(twilioParams({ Body: secret }), { signature: 'forged' }),
      h.deps,
    );

    const written = JSON.stringify(logged);
    expect(written).not.toContain(secret);
    expect(written).not.toContain(PHONE);
    expect(written).not.toContain('4165551234');
  });

  it('never puts the auth token in a response body', async () => {
    const h = harness();
    const res = await handleTwilioInboundRequest(
      twilioRequest(twilioParams(), { signature: 'forged' }),
      h.deps,
    );
    expect(await res.text()).not.toContain(AUTH_TOKEN);
  });
});

describe('WhatsApp continuity — whatsapp:+1416… IS +1416… (one person, one family)', () => {
  const WA_SID = 'SM22222222222222222222222222222222';

  /** THE continuity test: a family enrolled via the SMS blind index, reached over
   * WhatsApp, resolves to the SAME family — and the ledger records the real pipe. */
  it('routes a signed WhatsApp webhook to the family the SMS hash enrolled, recording channel whatsapp', async () => {
    const h = harness();
    const { familyId, userId } = enrol(h.fake); // seeded via phoneBlindIndex(PHONE) — the SMS twin
    closeIntake(h.fake);

    const params = twilioParams({
      From: `whatsapp:${PHONE}`,
      Body: 'can you move swimming to Thursday?',
      MessageSid: WA_SID,
    });
    const res = await handleTwilioInboundRequest(twilioRequest(params), h.deps);
    expect(res.status).toBe(200);

    const message = h.fake
      .rows(schema.channelMessages)
      .find((r) => r.providerMessageId === WA_SID);
    expect(message).toMatchObject({
      familyId,
      parentUserId: userId,
      channel: 'whatsapp',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'can you move swimming to Thursday?',
    });

    expect(h.jobs).toEqual([
      {
        family_id: familyId,
        parent_user_id: userId,
        channel_message_id: message?.id,
        provider_message_id: WA_SID,
        received_at: NOW.toISOString(),
      },
    ]);

    // The intake deps were built knowing the pipe, so the reply can ride it back.
    expect(h.intakeTransports).toEqual(['whatsapp']);
  });

  it('a WhatsApp STOP revokes the SAME channel row the SMS enrolment created (no carrier STOP on WhatsApp)', async () => {
    const h = harness();
    enrol(h.fake);

    const params = twilioParams({ From: `whatsapp:${PHONE}`, Body: 'STOP', MessageSid: WA_SID });
    const res = await handleTwilioInboundRequest(twilioRequest(params), h.deps);

    expect(res.status).toBe(200);
    expect(h.transport.bodies()).toEqual([STOP_ACK]);
    const revoked = h.fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.parentChannels,
    );
    expect(revoked.length).toBeGreaterThan(0);
  });

  it('rate limiting keys on the BARE number — one budget per person across both pipes', async () => {
    const h = harness();
    const limiter = h.deps.intake('sms').limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check');

    const params = twilioParams({
      From: `whatsapp:${PHONE}`,
      Body: '',
      NumMedia: '1',
      MessageSid: WA_SID,
    });
    await handleTwilioInboundRequest(twilioRequest(params), h.deps);

    expect(spy).toHaveBeenCalledWith(
      phoneBlindIndex(PHONE),
      'sms-inbound',
      expect.objectContaining({ limit: 30 }),
    );
  });

  it('drops whatsapp:garbage exactly as it drops garbage — the one normalizer still refuses', async () => {
    const h = harness();

    const params = twilioParams({ From: 'whatsapp:not-a-number', MessageSid: WA_SID });
    const res = await handleTwilioInboundRequest(twilioRequest(params), h.deps);

    expect(res.status).toBe(200);
    expect(h.fake.writes).toHaveLength(0);
    expect(h.transport.sent).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
  });
});
