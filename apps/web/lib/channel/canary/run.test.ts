import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily, type SeededFamily, type TestDb } from '~/lib/testing/pglite';
import {
  isValidTwilioSignature,
  parseTwilioParams,
  twilioWebhookUrl,
} from '../twilio/signature';
import { CANARY_ANSWERED_ACTION, CANARY_PHONE_E164 } from './config';
import { CANARY_SID_PREFIX, runInboundCanary } from './run';

/**
 * The write side, over the real tables.
 *
 * The order is the design: config, then household, then INJECT, then verify
 * the PREVIOUS tick. Inject-before-verify is what makes a broken lane keep
 * being probed and clears the alarm on the tick after a fix lands; the
 * household check ahead of both is what stops an unseeded canary reaching the
 * intake path, where an unknown `From` would start a conversation and text the
 * probe number every ten minutes.
 */

const KEY = Buffer.alloc(32, 11).toString('base64');
const AUTH_TOKEN = 'twilio_auth_token_value';
const APP_URL = 'https://app.villagehale.com';
const NOW = new Date('2026-09-09T12:04:30.000Z');

let db: TestDb;
let canary: SeededFamily;

interface Capture {
  url: string;
  body: string;
  signature: string | null;
}

/** A fake door, answering `status`, recording exactly what crossed the wire. */
function fakeDoor(status = 200): { fetch: typeof globalThis.fetch; calls: Capture[] } {
  const calls: Capture[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      body: String(init.body),
      signature: new Headers(init.headers).get('x-twilio-signature'),
    });
    return new Response('<Response/>', { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, calls };
}

function run(fetchImpl: typeof globalThis.fetch, now = NOW): Promise<void> {
  return runInboundCanary({ database: db.database, fetch: fetchImpl, now: () => now });
}

/** A landed injection, as the door records one. */
async function seedPriorInjection(
  database: Database,
  sentAt: Date,
  sid = `${CANARY_SID_PREFIX}2026-09-09T11:54:00.000Z`,
): Promise<string> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: canary.familyId,
      parentUserId: canary.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: sid,
      status: 'delivered',
      body: 'CANARY',
      sentAt,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('seedPriorInjection: insert returned no row');
  return row.id;
}

async function seedAnswer(database: Database, channelMessageId: string, at: Date): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: canary.familyId,
    actor: canary.parentUserId,
    actionTaken: CANARY_ANSWERED_ACTION,
    targetTable: 'channel_messages',
    targetId: channelMessageId,
    occurredAt: at,
  });
}

beforeAll(async () => {
  db = await createTestDb();
  canary = await seedFamily(db.database, 'Hale inbound canary');
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('APP_URL', APP_URL);
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC00000000000000000000000000000000');
  vi.stubEnv('TWILIO_AUTH_TOKEN', AUTH_TOKEN);
  vi.stubEnv('TWILIO_API_KEY_SID', 'SK11111111111111111111111111111111');
  vi.stubEnv('TWILIO_API_KEY_SECRET', 'api_key_secret_value');
  vi.stubEnv('TWILIO_FROM_NUMBER', '+14165550000');

  await db.database.delete(schema.auditLog);
  await db.database.delete(schema.channelMessages);
  await db.database.delete(schema.parentChannels);
  await db.database.insert(schema.parentChannels).values({
    userId: canary.parentUserId,
    familyId: canary.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
    phoneE164Hash: phoneBlindIndex(CANARY_PHONE_E164),
    verifiedAt: NOW,
  });
});

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('runInboundCanary · the injection', () => {
  it('signs the canonical origin, exactly as the door verifies it', async () => {
    const door = fakeDoor();
    const prior = await seedPriorInjection(db.database, new Date(NOW.getTime() - 10 * 60_000));
    await seedAnswer(db.database, prior, NOW);

    await run(door.fetch);

    const [call] = door.calls;
    if (!call) throw new Error('the canary never posted');
    expect(call.url).toBe(`${APP_URL}/api/channels/twilio/inbound`);

    // The REAL verifier, over the URL the route rebuilds — appBaseUrl() plus
    // the path, never the request Host (signature.ts). If this passes, a
    // genuine Twilio POST and this one are indistinguishable at the gate.
    expect(
      isValidTwilioSignature({
        authToken: AUTH_TOKEN,
        url: twilioWebhookUrl(new Request(call.url)),
        params: parseTwilioParams(call.body),
        signature: call.signature,
      }),
    ).toBe(true);

    const params = parseTwilioParams(call.body);
    expect(params.From).toBe('+14375550100');
    expect(params.To).toBe('+14165550000');
    expect(params.Body).toBe('CANARY');
    // Minute-truncated: a double invocation inside one minute lands on the
    // partial unique index as a 'duplicate' rather than as a second turn.
    expect(params.MessageSid).toBe(`${CANARY_SID_PREFIX}2026-09-09T12:04:00.000Z`);
  });

  it('a signature computed over another origin is refused by that same verifier', async () => {
    // POSITIVE CONTROL for the assertion above: it is not vacuously true.
    const door = fakeDoor();
    const prior = await seedPriorInjection(db.database, new Date(NOW.getTime() - 10 * 60_000));
    await seedAnswer(db.database, prior, NOW);

    await run(door.fetch);
    const [call] = door.calls;
    if (!call) throw new Error('the canary never posted');

    expect(
      isValidTwilioSignature({
        authToken: AUTH_TOKEN,
        url: 'https://forged.example.com/api/channels/twilio/inbound',
        params: parseTwilioParams(call.body),
        signature: call.signature,
      }),
    ).toBe(false);
  });
});

describe('runInboundCanary · fail-closed ordering', () => {
  it('refuses before posting anything when Twilio is not configured', async () => {
    vi.stubEnv('TWILIO_AUTH_TOKEN', '');
    const door = fakeDoor();

    await expect(run(door.fetch)).rejects.toThrow(/not configured/);
    expect(door.calls).toHaveLength(0);
  });

  it('refuses before posting anything when the household is not seeded', async () => {
    // The whole reason this check precedes the injection: an unknown `From`
    // reaches the intake machine, which would start a conversation and text
    // +1 437-555-0100 every single tick.
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: NOW })
      .where(eq(schema.parentChannels.familyId, canary.familyId));
    const door = fakeDoor();

    await expect(run(door.fetch)).rejects.toThrow(/household not seeded/);
    expect(door.calls).toHaveLength(0);
  });

  it('names the door when the door refuses the injection', async () => {
    const door = fakeDoor(403);

    // 403 is signature/APP_URL drift, 503 is twilio_not_configured — either way
    // the webhook itself is the thing to look at, and the throw says so.
    await expect(run(door.fetch)).rejects.toThrow(/door refused the injection \(403\)/);
  });

  it('pages when no injection landed, having injected FIRST', async () => {
    const door = fakeDoor();

    await expect(run(door.fetch)).rejects.toThrow(/no injection in the last 22 minutes/);
    // Inject-before-verify: a broken lane keeps being probed, so the alarm
    // clears itself on the tick after the fix lands.
    expect(door.calls).toHaveLength(1);
  });

  it('pages when the turn landed but nothing answered it', async () => {
    const door = fakeDoor();
    await seedPriorInjection(db.database, new Date(NOW.getTime() - 10 * 60_000));

    await expect(run(door.fetch)).rejects.toThrow(/was never answered/);
  });

  it('passes when the previous tick landed AND carries its answer', async () => {
    const door = fakeDoor();
    const prior = await seedPriorInjection(db.database, new Date(NOW.getTime() - 10 * 60_000));
    await seedAnswer(db.database, prior, new Date(NOW.getTime() - 10 * 60_000 + 1_000));

    await expect(run(door.fetch)).resolves.toBeUndefined();
  });

  it('refuses to count an answer from BEFORE the window — a stopped canary cannot look alive', async () => {
    const door = fakeDoor();
    const stale = new Date(NOW.getTime() - 30 * 60_000);
    const prior = await seedPriorInjection(db.database, stale);
    await seedAnswer(db.database, prior, stale);

    await expect(run(door.fetch)).rejects.toThrow(/no injection in the last 22 minutes/);
  });
});
