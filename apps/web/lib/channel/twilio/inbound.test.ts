import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_ACK } from '~/lib/channel/intake/copy';
import { FakeExtractor, FakeIntentReader, type FakeDb, fakeRadar, makeFakeDb } from '~/lib/channel/intake/fakes';
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
  deps: TwilioInboundDeps;
  intakeBuilds: number;
}

function harness(): Harness {
  const fake = makeFakeDb();
  const transport = new FakeTransport();
  const jobs: ChannelMessageReceivedJob[] = [];
  const state = { intakeBuilds: 0 };
  const intake: IntakeDeps = {
    transport,
    extractor: new FakeExtractor([{ children: [], postalCode: null }]),
    intentReader: new FakeIntentReader([
      { intent: 'assent', verbatim: 'yes', interpretation: 'plain yes' },
    ]),
    radar: fakeRadar,
    limiter: new FakeRateLimiter(() => NOW.getTime()),
    now: NOW,
  };
  const h: Harness = {
    fake,
    transport,
    jobs,
    intakeBuilds: 0,
    deps: {
      database: fake.db,
      intake: () => {
        state.intakeBuilds += 1;
        h.intakeBuilds = state.intakeBuilds;
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

/** An enrolled parent whose intake is finished — the family C1's handoff is for. */
function enrolParent(fake: FakeDb, phone = PHONE): { familyId: string; userId: string } {
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
  return { familyId, userId };
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
    enrolParent(h.fake);

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
    const limiter = h.deps.intake().limiter as FakeRateLimiter;
    const spy = vi.spyOn(limiter, 'check');

    await routeTwilioInbound(h.deps, inbound({ body: '' }), 1);

    expect(spy).toHaveBeenCalledWith(
      phoneBlindIndex(PHONE),
      'sms-inbound',
      expect.objectContaining({ limit: 30 }),
    );
  });

  it('stays silent when the media path is over the limit', async () => {
    const h = harness();
    const limiter = h.deps.intake().limiter as FakeRateLimiter;
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
    const { familyId, userId } = enrolParent(h.fake);
    // A finished intake: the machine finds no open conversation and defers to A3.
    h.fake.db.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      state: 'complete',
      closedAt: NOW,
    } as never);

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
    h.fake.db.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      state: 'complete',
      closedAt: NOW,
    } as never);

    const outcome = await routeTwilioInbound(h.deps, inbound({ body: 'hello again' }), 0);

    // The handoff resolves through `resolveVerifiedChannelByPhone`, which never returns
    // a revoked row — so a number that pressed STOP is structurally unable to become a
    // C1 conversation. (What the machine does with such a text is M2's call, not A3's;
    // see the PR's live-config note on Twilio Advanced Opt-Out.)
    expect(outcome).not.toBe('handed_off');
    expect(h.jobs).toHaveLength(0);
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(0);
  });

  it('is idempotent on a webhook RETRY — one ledger row, one job', async () => {
    const h = harness();
    enrolParent(h.fake);
    h.fake.db.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      state: 'complete',
      closedAt: NOW,
    } as never);

    const first = await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0);
    const retry = await routeTwilioInbound(h.deps, inbound({ body: 'move swimming' }), 0);

    expect(first).toBe('handed_off');
    expect(retry).toBe('duplicate');
    expect(h.fake.rows(schema.channelMessages)).toHaveLength(1);
    expect(h.jobs).toHaveLength(1);
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
    enrolParent(h.fake);
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
