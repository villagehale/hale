import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COLD_START_ASK } from '~/lib/channel/intake/copy';
import { type FakeDb, makeFakeDb } from '~/lib/channel/intake/fakes';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';
import { VOICE_GREETING, VOICE_GREETING_NO_TEXT, VOICE_RELAY_GREETING, VOICE_TEXT_OPENER } from './copy';
import { verifyRelayToken } from './relay-token';
import { type TwilioVoiceDeps, answerVoiceCall, handleTwilioVoiceRequest, voiceTwiml } from './voice';

/**
 * The voice front door, end to end minus the network and the phone line.
 *
 * The signature is computed here from Twilio's published scheme, never by the module
 * under test, so a request these helpers build is byte-for-byte what Twilio would post.
 */

const AUTH_TOKEN = 'twilio_auth_token_value';
const APP_URL = 'https://app.villagehale.com';
const VOICE_URL = `${APP_URL}/api/channels/twilio/voice`;
const PHONE = '+14165551234';
const CALL_SID = 'CA11111111111111111111111111111111';
const NOW = new Date('2026-08-12T15:00:00.000Z');
const FAMILY_ID = '00000000-0000-4000-8000-0000000000f1';
const USER_ID = '00000000-0000-4000-8000-0000000000u1';

function configure(): void {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
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

/** Twilio's inbound-call webhook parameters. */
function voiceParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: 'AC00000000000000000000000000000000',
    CallSid: CALL_SID,
    CallStatus: 'ringing',
    Called: '+14165550000',
    Direction: 'inbound',
    From: PHONE,
    To: '+14165550000',
    ...overrides,
  };
}

function voiceRequest(
  params: Record<string, string>,
  options: { signature?: string | null } = {},
): Request {
  const signature = options.signature === undefined ? sign(VOICE_URL, params) : options.signature;
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (signature !== null) headers['x-twilio-signature'] = signature;
  return new Request(VOICE_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
}

interface Harness {
  fake: FakeDb;
  transport: FakeTransport;
  errors: unknown[][];
  deps: TwilioVoiceDeps;
  transportBuilds: number;
}

function harness(transport: FakeTransport = new FakeTransport()): Harness {
  const fake = makeFakeDb();
  const errors: unknown[][] = [];
  const h: Harness = {
    fake,
    transport,
    errors,
    transportBuilds: 0,
    deps: {
      database: fake.db,
      transport: () => {
        h.transportBuilds += 1;
        return transport;
      },
      log: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
      now: () => NOW,
    },
  };
  return h;
}

/** A transport that refuses every send, the way the real one does when the Twilio
 * credentials are absent (`requireTwilioConfig` throws inside `send`). */
function refusingTransport(message: string): FakeTransport {
  const transport = new FakeTransport();
  transport.send = async () => {
    throw new Error(message);
  };
  return transport;
}

/** An enrolled household member holding a live, verified channel on this number. */
function enrol(fake: FakeDb, phone = PHONE): void {
  fake.db
    .insert(schema.parentChannels)
    .values({
      userId: USER_ID,
      familyId: FAMILY_ID,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      consentRecordId: '00000000-0000-4000-8000-0000000000c1',
    })
    .returning({ id: schema.parentChannels.id });
}

/** A number that pressed STOP: the channel row survives, stamped revoked. */
function unsubscribe(fake: FakeDb, phone = PHONE): void {
  fake.db
    .insert(schema.parentChannels)
    .values({
      userId: USER_ID,
      familyId: FAMILY_ID,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      revokedAt: new Date('2026-07-01T00:00:00.000Z'),
      consentRecordId: '00000000-0000-4000-8000-0000000000c1',
    })
    .returning({ id: schema.parentChannels.id });
}

function auditRows(fake: FakeDb): Record<string, unknown>[] {
  return fake.rows(schema.auditLog);
}

function sessionRows(fake: FakeDb): Record<string, unknown>[] {
  return fake.rows(schema.smsIntakeSessions);
}

function messageRows(fake: FakeDb): Record<string, unknown>[] {
  return fake.rows(schema.channelMessages);
}

beforeEach(configure);
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── authentication ───────────────────────────────────────────────────────────

describe('the signature gate', () => {
  it('refuses a forged request with 403 and no side effect whatsoever', async () => {
    const h = harness();

    const response = await handleTwilioVoiceRequest(
      voiceRequest(voiceParams(), { signature: 'not-the-signature-twilio-computed' }),
      h.deps,
    );

    expect(response.status).toBe(403);
    expect(h.transport.sent).toEqual([]);
    expect(h.fake.writes).toEqual([]);
    expect(auditRows(h.fake)).toEqual([]);
    // A forged request must not even cause a provider client to be constructed.
    expect(h.transportBuilds).toBe(0);
  });

  it('refuses an unsigned request', async () => {
    const h = harness();

    const response = await handleTwilioVoiceRequest(
      voiceRequest(voiceParams(), { signature: null }),
      h.deps,
    );

    expect(response.status).toBe(403);
    expect(h.fake.writes).toEqual([]);
  });

  it('refuses a signature computed over different parameters (a replayed body swap)', async () => {
    const h = harness();
    const params = voiceParams();
    const signature = sign(VOICE_URL, params);

    const response = await handleTwilioVoiceRequest(
      voiceRequest({ ...params, From: '+15195559999' }, { signature }),
      h.deps,
    );

    expect(response.status).toBe(403);
    expect(h.transport.sent).toEqual([]);
  });

  it('is dark, not broken, when the Twilio leg is not provisioned', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    const h = harness();

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);

    expect(response.status).toBe(503);
    expect(h.fake.writes).toEqual([]);
  });
});

// ── the stranger who calls ───────────────────────────────────────────────────

describe('a stranger calls', () => {
  it('speaks the greeting in a neural voice and hangs up', async () => {
    const h = harness();

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const twiml = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/xml; charset=utf-8');
    expect(twiml).toContain('<Say voice="Polly.Joanna-Neural">');
    expect(twiml).toContain(VOICE_GREETING);
    expect(twiml).toContain('<Hangup/>');
    expect(twiml.indexOf('<Say')).toBeLessThan(twiml.indexOf('<Hangup/>'));
    // No `language`: a Polly voice carries its own, and Twilio fails the whole <Say> on
    // a voice/language pairing it does not recognise.
    expect(twiml).not.toContain('language=');
  });

  it('texts them the cold-start opener, and asks intake’s question verbatim', async () => {
    const h = harness();

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toEqual({ outcome: 'texted_cold' });
    expect(h.transport.sent).toEqual([{ to: PHONE, body: VOICE_TEXT_OPENER }]);
    // Shared with the texted greeting, not re-worded: one extractor reads both replies.
    expect(VOICE_TEXT_OPENER).toContain(COLD_START_ASK);
  });

  it('opens the intake conversation, so their reply is heard rather than re-greeted', async () => {
    const h = harness();

    await answerVoiceCall(h.deps, { from: PHONE, callSid: CALL_SID, receivedAt: NOW });

    const [session] = sessionRows(h.fake);
    expect(session).toMatchObject({
      state: 'awaiting_details',
      phoneHash: phoneBlindIndex(PHONE),
      closedAt: null,
    });
  });

  it('keeps the opener in the session transcript, encrypted, for replay at provisioning', async () => {
    const h = harness();

    await answerVoiceCall(h.deps, { from: PHONE, callSid: CALL_SID, receivedAt: NOW });

    const [session] = sessionRows(h.fake);
    const data = JSON.parse(decryptString(session?.dataEncrypted as string));
    expect(data.transcript).toEqual([
      { direction: 'out', body: VOICE_TEXT_OPENER, providerId: 'fake-out-1', at: NOW.toISOString() },
    ]);
  });

  it('never writes an audit row it has no family to hang one on', async () => {
    const h = harness();

    await answerVoiceCall(h.deps, { from: PHONE, callSid: CALL_SID, receivedAt: NOW });

    // audit_log.family_id is NOT NULL and this caller has no family yet. The session row
    // is the record until provisioning replays it (the intake precedent, rule #6's
    // stated boundary) - so this asserts the boundary rather than a missing write.
    expect(auditRows(h.fake)).toEqual([]);
    expect(sessionRows(h.fake)).toHaveLength(1);
  });

  it('texts a caller back once, however many times they call', async () => {
    const h = harness();

    const first = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const second = await handleTwilioVoiceRequest(
      voiceRequest(voiceParams({ CallSid: 'CA22222222222222222222222222222222' })),
      h.deps,
    );

    expect(await first.text()).toContain(VOICE_GREETING);
    // Still answered warmly - the caller must never hear silence for having called twice.
    expect(await second.text()).toContain(VOICE_GREETING);
    expect(h.transport.sent).toHaveLength(1);
    expect(sessionRows(h.fake)).toHaveLength(1);
  });

  it('does not re-open on a caller who is already mid-intake by text', async () => {
    const h = harness();
    await h.deps.database.insert(schema.smsIntakeSessions).values({
      phoneHash: phoneBlindIndex(PHONE),
      phoneEncrypted: encryptString(PHONE),
      state: 'awaiting_follow_up',
      dataEncrypted: encryptString(JSON.stringify({ transcript: [] })),
    });

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toEqual({ outcome: 'already_texted' });
    expect(h.transport.sent).toEqual([]);
    expect(sessionRows(h.fake)).toHaveLength(1);
  });
});

// ── the parent Hale already works for ────────────────────────────────────────

describe('an enrolled parent calls', () => {
  it('is connected to a conversation, not texted a lead', async () => {
    const h = harness();
    enrol(h.fake);

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toMatchObject({ outcome: 'relayed' });
    // Nothing is sent and no intake conversation is started: they are already talking.
    expect(h.transport.sent).toEqual([]);
    expect(sessionRows(h.fake)).toEqual([]);
    expect(messageRows(h.fake)).toEqual([]);
  });

  it('hands Twilio a socket URL carrying a ticket bound to THIS call and THIS family', async () => {
    const h = harness();
    enrol(h.fake);

    const answer = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });
    if (answer.outcome !== 'relayed') throw new Error('expected a relayed call');

    const url = new URL(answer.relayUrl);
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('app.villagehale.com');
    expect(url.pathname).toBe('/api/channels/twilio/relay');
    expect(verifyRelayToken(url.searchParams.get('t'), CALL_SID, NOW)).toEqual({
      ok: true,
      ticket: { callSid: CALL_SID, familyId: FAMILY_ID, parentUserId: USER_ID },
    });
    // Rule #1: the URL travels to Twilio and is logged there. Two opaque uuids, no number.
    expect(answer.relayUrl).not.toContain(PHONE);
  });

  it('speaks the AI + no-recording disclosure before the socket says anything', async () => {
    const h = harness();
    enrol(h.fake);

    const twiml = await (
      await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps)
    ).text();

    expect(twiml).toContain('<Connect><ConversationRelay ');
    expect(twiml).toContain(VOICE_RELAY_GREETING);
    expect(VOICE_RELAY_GREETING).toContain('AI');
    expect(VOICE_RELAY_GREETING).toContain("don't keep a recording");
    // The three the call must never carry: no audio, no Twilio-side transcript, and no
    // hang-up (the socket owns when the call ends). Matched as ATTRIBUTES, because the
    // greeting itself contains the word "recording" — that is the promise, not a setting.
    expect(twiml).not.toMatch(/\srecord=/);
    expect(twiml).not.toMatch(/\sintelligenceService=/);
    expect(twiml).not.toContain('<Hangup/>');
  });

  it('records the call itself, with the number masked and no text claimed', async () => {
    const h = harness();
    enrol(h.fake);

    await answerVoiceCall(h.deps, { from: PHONE, callSid: CALL_SID, receivedAt: NOW });

    const [received] = auditRows(h.fake);
    expect(auditRows(h.fake).map((row) => row.actionTaken)).toEqual(['voice_call_received']);
    expect(received).toMatchObject({ familyId: FAMILY_ID, actor: USER_ID });
    expect(received?.after).toMatchObject({
      maskedPhone: '••• ••• 1234',
      callSid: CALL_SID,
      textSent: false,
      reason: 'relayed',
    });
    // Rule #1: the raw number is never stored anywhere, audit included.
    expect(JSON.stringify(received?.after)).not.toContain(PHONE);
  });

  it('connects every call, with no once-a-day claim to lose', async () => {
    const h = harness();
    enrol(h.fake);

    const first = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const second = await handleTwilioVoiceRequest(
      voiceRequest(voiceParams({ CallSid: 'CA33333333333333333333333333333333' })),
      h.deps,
    );

    expect(await first.text()).toContain('ConversationRelay');
    expect(await second.text()).toContain('ConversationRelay');
    expect(h.transport.sent).toEqual([]);
  });

  it('never asks a family it has served for months to re-introduce their children', async () => {
    const h = harness();
    enrol(h.fake);

    const twiml = await (
      await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps)
    ).text();

    expect(twiml).not.toContain(COLD_START_ASK);
  });
});

// ── the caller who said STOP ─────────────────────────────────────────────────

describe('an unsubscribed number calls', () => {
  it('is answered, and is not texted', async () => {
    const h = harness();
    unsubscribe(h.fake);

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const twiml = await response.text();

    expect(twiml).toContain(VOICE_GREETING_NO_TEXT);
    expect(twiml).not.toContain('sent you a message');
    expect(h.transport.sent).toEqual([]);
    expect(sessionRows(h.fake)).toEqual([]);
    expect(messageRows(h.fake)).toEqual([]);
  });

  it('records the refusal as a named outcome, not as silence', async () => {
    const h = harness();
    unsubscribe(h.fake);

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toEqual({ outcome: 'unsubscribed' });
    const [received] = auditRows(h.fake);
    expect(received).toMatchObject({ familyId: FAMILY_ID, actionTaken: 'voice_call_received' });
    expect(received?.after).toMatchObject({ textSent: false, reason: 'unsubscribed' });
  });

  it('still connects a number that unsubscribed once and enrolled again since', async () => {
    // A recycled or re-started number holds BOTH rows. The live channel is the answer to
    // "may we talk to this"; the revoked row is history about a previous owner.
    const h = harness();
    unsubscribe(h.fake);
    enrol(h.fake);

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toMatchObject({ outcome: 'relayed' });
  });
});

// ── the send that does not happen ────────────────────────────────────────────

describe('when the text cannot be sent', () => {
  it('still answers the call, and does not claim a message that never went', async () => {
    const h = harness(refusingTransport('twilio not configured: missing TWILIO_API_KEY_SID'));

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const twiml = await response.text();

    expect(response.status).toBe(200);
    expect(twiml).toContain(VOICE_GREETING_NO_TEXT);
    expect(twiml).not.toContain('sent you a message');
  });

  it('names the outcome and logs it, rather than failing quietly', async () => {
    const h = harness(refusingTransport('twilio send failed: HTTP 500, twilio code 20500'));

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toEqual({ outcome: 'send_failed' });
    expect(h.errors).toHaveLength(1);
    // Rule #1: the operator line carries the shape of the failure, never the number.
    expect(JSON.stringify(h.errors)).not.toContain(PHONE);
  });

  it('releases the stranger’s claim, so calling back still reaches them', async () => {
    const h = harness(refusingTransport('twilio send failed: HTTP 500, twilio code 20500'));

    await answerVoiceCall(h.deps, { from: PHONE, callSid: CALL_SID, receivedAt: NOW });

    // A held-open session would cost twice: no second call could text them, and their
    // own first text would skip the greeting and be read as intake details.
    const [session] = sessionRows(h.fake);
    expect(session?.closedAt).toEqual(NOW);
  });

  it('cannot fail this way for an enrolled parent — their call touches no transport', async () => {
    const h = harness(refusingTransport('twilio send failed: HTTP 500, twilio code 20500'));
    enrol(h.fake);

    const outcome = await answerVoiceCall(h.deps, {
      from: PHONE,
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toMatchObject({ outcome: 'relayed' });
    expect(h.transportBuilds).toBe(0);
  });
});

// ── malformed and hostile input ──────────────────────────────────────────────

describe('an authentic call carrying nothing to act on', () => {
  it('answers a number it cannot canonicalize without texting anyone', async () => {
    const h = harness();

    const outcome = await answerVoiceCall(h.deps, {
      from: 'anonymous',
      callSid: CALL_SID,
      receivedAt: NOW,
    });

    expect(outcome).toEqual({ outcome: 'invalid_number' });
    expect(h.transport.sent).toEqual([]);
    expect(h.fake.writes).toEqual([]);
  });

  it('answers a request with no From at all', async () => {
    const h = harness();
    const params = Object.fromEntries(
      Object.entries(voiceParams()).filter(([key]) => key !== 'From'),
    );

    const response = await handleTwilioVoiceRequest(voiceRequest(params), h.deps);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(VOICE_GREETING_NO_TEXT);
    expect(h.transport.sent).toEqual([]);
  });

  it('answers the phone even when the database is down', async () => {
    const h = harness();
    h.deps.database = new Proxy(
      {},
      {
        get() {
          throw new Error('connection terminated unexpectedly');
        },
      },
    ) as typeof h.deps.database;

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);

    // A caller is on the line. An unhandled throw here is Twilio's error recording,
    // which is exactly the first impression this feature exists to end.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(VOICE_GREETING_NO_TEXT);
    expect(h.errors).toHaveLength(1);
  });
});

// ── the wire format ──────────────────────────────────────────────────────────

describe('the TwiML', () => {
  it('is a well-formed document Twilio will accept', async () => {
    const h = harness();

    const response = await handleTwilioVoiceRequest(voiceRequest(voiceParams()), h.deps);
    const twiml = await response.text();

    expect(twiml).toMatch(
      /^<\?xml version="1\.0" encoding="UTF-8"\?><Response><Say [^>]+>.*<\/Say><Hangup\/><\/Response>$/s,
    );
  });

  it('escapes markup, so no spoken line can ever break the document', async () => {
    const twiml = await voiceTwiml('Ampersands & <Hangup/> tags').text();

    expect(twiml).toContain('Ampersands &amp; &lt;Hangup/&gt; tags');
    // Exactly one Hangup, and it is ours.
    expect(twiml.match(/<Hangup\/>/g)).toHaveLength(1);
  });
});

describe('the texted line stays inside the carrier budget', () => {
  it('VOICE_TEXT_OPENER', () => {
    expect(smsEncoding(VOICE_TEXT_OPENER)).toBe('gsm7');
    expect(smsSegments(VOICE_TEXT_OPENER)).toBeLessThanOrEqual(2);
  });

  it('gives the stranger the unsubscribe mechanism their inquiry did not include', () => {
    expect(VOICE_TEXT_OPENER).toContain('STOP');
  });
});
