import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { schedulePeriodSeconds } from '~/lib/cron/deadman';
import { createTestDb, seedFamily, type SeededFamily, type TestDb } from '~/lib/testing/pglite';
import vercelConfig from '~/vercel.json';
import {
  isValidTwilioSignature,
  parseTwilioParams,
  twilioWebhookUrl,
} from '../twilio/signature';
import { CANARY_ANSWERED_ACTION, CANARY_PHONE_E164, canaryChannel } from './config';
import { CANARY_SID_PREFIX, runInboundCanary, VERIFY_NOT_BEFORE_MS } from './run';

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
const CANARY_CRON_PATH = '/api/cron/inbound-canary';

let db: TestDb;
let canary: SeededFamily;

interface Capture {
  url: string;
  body: string;
  signature: string | null;
}

/**
 * A fake door that answers `status`, records what crossed the wire, and — on a
 * 2xx — does the one thing the real door does that this cron can see: writes the
 * inbound `channel_messages` row, stamped `sentAt = its own clock`
 * (inbound.ts:412 + :288).
 *
 * That clock belongs to the WEBHOOK instance, not to the cron's. `skewMs` is the
 * difference, and NEGATIVE skew — the webhook running behind — is the only case
 * the verify window's upper bound exists for. Without the bound, the canary
 * selects the row it posted milliseconds ago, whose answer cannot have landed
 * yet (the drain kick is async), and pages every tick forever.
 */
function fakeDoor(options: { status?: number; skewMs?: number } = {}): {
  fetch: typeof globalThis.fetch;
  calls: Capture[];
} {
  const { status = 200, skewMs = 0 } = options;
  const calls: Capture[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    calls.push({
      url,
      body,
      signature: new Headers(init.headers).get('x-twilio-signature'),
    });
    if (status < 300) {
      const params = parseTwilioParams(body);
      await db.database.insert(schema.channelMessages).values({
        familyId: canary.familyId,
        parentUserId: canary.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: params.MessageSid,
        status: 'delivered',
        body: params.Body,
        sentAt: new Date(NOW.getTime() + skewMs),
      });
    }
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

  it('refuses before posting anything when the household is inactive', async () => {
    // Revoked (or never-verified) is refuse-closed: seedCanaryHousehold names
    // `inactive` and does not re-activate. An unknown `From` must never reach
    // intake and text +1 437-555-0100 every tick.
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: NOW })
      .where(eq(schema.parentChannels.familyId, canary.familyId));
    const door = fakeDoor();

    await expect(run(door.fetch)).rejects.toThrow(/household inactive/);
    expect(door.calls).toHaveLength(0);
  });

  it('re-seeds a missing household, then injects before verifying', async () => {
    // Roster wipe (hard-delete of test families) can take the canary with it.
    // Seed restores the household; this tick still has no previous inject to
    // verify, so it pages once and the next tick clears the alarm.
    await db.database.delete(schema.parentChannels);
    const door = fakeDoor();

    await expect(run(door.fetch)).rejects.toThrow(/no injection in the last 22 minutes/);
    expect(door.calls).toHaveLength(1);
    expect(await canaryChannel(db.database)).not.toBeNull();
  });

  it('names the door when the door refuses the injection', async () => {
    const door = fakeDoor({ status: 403 });

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

  it('grades the PREVIOUS tick, never the row it just posted, even with the door ninety seconds behind', async () => {
    // The row the door just wrote carries the WEBHOOK instance's clock. Nothing
    // guarantees it is later than the cron's — so the upper bound, not the
    // ordering of two wall clocks, is what keeps this tick out of its own
    // verdict. Grading it would read a turn whose answer the drain has not had
    // time to write, and page every ten minutes forever.
    const door = fakeDoor({ skewMs: -90_000 });
    const prior = await seedPriorInjection(db.database, new Date(NOW.getTime() - 10 * 60_000));
    await seedAnswer(db.database, prior, new Date(NOW.getTime() - 10 * 60_000 + 1_000));

    await expect(run(door.fetch)).resolves.toBeUndefined();

    // Positive control: the injection really did land, so the pass above is not
    // the door quietly writing nothing.
    const landed = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        eq(
          schema.channelMessages.providerMessageId,
          `${CANARY_SID_PREFIX}2026-09-09T12:04:00.000Z`,
        ),
      );
    expect(landed).toHaveLength(1);
  });

  it('keeps a window wide enough for two ticks of the SHIPPED cadence', async () => {
    // The 22 minutes and the manifest's `9-59/10` are one decision in two files.
    // At a 20-minute cadence the previous tick sits at the very edge and any
    // scheduler lag reads as "no injection" — a false page, from an edit that
    // never touched this file.
    const entry = vercelConfig.crons.find((cron) => cron.path === CANARY_CRON_PATH);
    if (!entry) throw new Error(`${CANARY_CRON_PATH} is not in vercel.json`);

    expect(VERIFY_NOT_BEFORE_MS).toBeGreaterThan(2 * schedulePeriodSeconds(entry.schedule) * 1_000);
  });
});
