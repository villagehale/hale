import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
  type ConnectorOfferPorts,
  connectorOfferDedupeKey,
  sendConnectorOffer,
} from './connector-offer';
import { intakeConnectorOffer } from './copy';
import { type FakeDb, makeFakeDb } from './fakes';
import { type ChannelTransport, FakeTransport } from './transport';

const KEY = Buffer.alloc(32, 7).toString('base64');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const PARENT = '00000000-0000-4000-8000-0000000000a1';
const PHONE = '+14165551234';
/** 08:00 in America/Toronto — the far side of the proactive quiet window. */
const NOW = new Date('2026-09-17T12:00:00.000Z');
/** 22:30 in America/Toronto. */
const NOW_QUIET = new Date('2026-09-18T02:30:00.000Z');

type Threaded = Array<{ familyId: string; parentUserId: string; body: string }>;

function ports(transport: ChannelTransport): { ports: ConnectorOfferPorts; threaded: Threaded } {
  const threaded: Threaded = [];
  return {
    threaded,
    ports: {
      transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
    },
  };
}

function refusing(code: string): ChannelTransport {
  return {
    async send() {
      throw new TwilioSendError(code, 400);
    },
  };
}

/** A family that finished intake: a verified sendable channel and a parent seat. */
function seeded(options: { role?: string; channel?: boolean } = {}): FakeDb {
  const fake = makeFakeDb();
  if (options.channel !== false) {
    void fake.db.insert(schema.parentChannels).values({
      userId: PARENT,
      kind: 'sms',
      phoneE164Hash: 'hash',
      phoneE164Encrypted: encryptString(PHONE),
      verifiedAt: NOW,
    } as never);
  }
  void fake.db
    .insert(schema.familyMembers)
    .values({ familyId: FAMILY, userId: PARENT, role: options.role ?? 'primary_parent' } as never);
  void fake.db.insert(schema.users).values({ id: PARENT, timezone: 'America/Toronto' } as never);
  return fake;
}

function offer(fake: FakeDb, offerPorts: ConnectorOfferPorts, now: Date = NOW) {
  return sendConnectorOffer(
    fake.db,
    { familyId: FAMILY, parentUserId: PARENT, phoneE164: PHONE, language: 'en', now },
    offerPorts,
  );
}

function ledgerRows(fake: FakeDb) {
  return fake.writes
    .filter((w) => w.table === schema.channelMessages)
    .map((w) => ({ op: w.op, ...w.payload }));
}

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.restoreAllMocks();
});

describe('the intake connector offer', () => {
  it('texts the link, threads the sentence, and ledgers it under its own dedupe key', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const { ports: offerPorts, threaded } = ports(transport);

    const outcome = await offer(fake, offerPorts);

    expect(outcome).toEqual({ status: 'sent', channelMessageId: expect.any(String) });
    expect(transport.sent).toHaveLength(1);
    const body = transport.bodies()[0] as string;
    expect(body).toContain('/connect?t=');
    expect(body).toContain('ignore this to skip');
    // The whole sentence is the copy module's, link and all — never assembled here.
    const url = (body.match(/https:\/\/\S+/) as RegExpMatchArray)[0];
    expect(body).toBe(intakeConnectorOffer('en', url));
    expect(threaded).toEqual([{ familyId: FAMILY, parentUserId: PARENT, body }]);

    const [claimed] = ledgerRows(fake);
    expect(claimed).toMatchObject({
      op: 'insert',
      familyId: FAMILY,
      parentUserId: PARENT,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
      dedupeKey: connectorOfferDedupeKey(FAMILY),
      status: 'queued',
    });
    // Rule #6: minting a sign-in capability is an act, and it has its own row.
    const audits = fake.writes.filter((w) => w.table === schema.auditLog).map((w) => w.payload);
    expect(audits.map((a) => a.actionTaken)).toEqual(['connector_link_minted']);
    expect(audits[0]?.after).toEqual({ provider: 'gcal' });
  });

  it('offers once per family - a second run reaches no provider and mints no second token', async () => {
    const fake = seeded();
    const transport = new FakeTransport();

    await offer(fake, ports(transport).ports);
    const second = await offer(fake, ports(transport).ports);

    expect(second).toEqual({ status: 'not_sent', reason: 'already_sent' });
    expect(transport.sent).toHaveLength(1);
    expect(fake.rows(schema.channelSigninTokens)).toHaveLength(1);
  });

  it('holds the offer through quiet hours WITHOUT spending the one key it has', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const warns: unknown[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warns.push(...args));

    const held = await offer(fake, ports(transport).ports, NOW_QUIET);

    expect(held).toEqual({ status: 'not_sent', reason: 'suppressed_quiet_hours' });
    expect(transport.sent).toEqual([]);
    expect(ledgerRows(fake)).toEqual([
      expect.objectContaining({
        status: 'suppressed_quiet_hours',
        dedupeKey: null,
        templateKey: INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
      }),
    ]);
    expect(warns.length).toBeGreaterThan(0);

    // The suppression is not the offer: the key is still unspent, so a later daylight
    // run still reaches the parent. A held message that consumed the key would be a
    // family who is simply never asked.
    const later = await offer(fake, ports(transport).ports);
    expect(later).toMatchObject({ status: 'sent' });
    expect(transport.sent).toHaveLength(1);
  });

  it('names a number it may not text, and mints nothing for it', async () => {
    const fake = seeded({ channel: false });
    const transport = new FakeTransport();

    const outcome = await offer(fake, ports(transport).ports);

    expect(outcome).toEqual({ status: 'not_sent', reason: 'not_enrolled' });
    expect(transport.sent).toEqual([]);
    expect(fake.rows(schema.channelSigninTokens)).toEqual([]);
    // The claimed row says what happened rather than sitting queued forever.
    expect(ledgerRows(fake).at(-1)).toMatchObject({ op: 'update', status: 'failed' });
  });

  it('marks the claimed row failed when the mint itself cannot land', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const database = {
      ...(fake.db as unknown as Record<string, unknown>),
      transaction: async () => {
        throw new Error('channel_signin_tokens is unreachable');
      },
    } as unknown as Database;

    const outcome = await sendConnectorOffer(
      database,
      { familyId: FAMILY, parentUserId: PARENT, phoneE164: PHONE, language: 'en', now: NOW },
      ports(transport).ports,
    );

    expect(outcome).toEqual({ status: 'not_sent', reason: 'mint_failed' });
    expect(transport.sent).toEqual([]);
    expect(ledgerRows(fake).at(-1)).toMatchObject({
      op: 'update',
      status: 'failed',
      errorCode: 'mint_failed',
    });
  });

  it('counts a refused offer as a failed send carrying the provider code', async () => {
    const fake = seeded();
    const { ports: offerPorts, threaded } = ports(refusing('21610'));

    const outcome = await offer(fake, offerPorts);

    expect(outcome).toEqual({ status: 'not_sent', reason: 'send_failed', code: '21610' });
    expect(threaded).toEqual([]);
    expect(ledgerRows(fake).at(-1)).toMatchObject({
      op: 'update',
      status: 'failed',
      errorCode: '21610',
    });
  });

  it('survives a port that throws something the provider never named', async () => {
    const fake = seeded();
    const outcome = await offer(fake, {
      transport: {
        async send() {
          throw new TypeError('fetch failed');
        },
      },
      threadMessage: async () => 'conv-1',
    });

    expect(outcome).toMatchObject({ status: 'not_sent', reason: 'send_failed' });
  });

  /**
   * Rule #1. The body carries a live sign-in capability for 15 minutes; a log line that
   * quoted it would put a session in a log aggregator, which is the one place a
   * single-use token must never be readable.
   */
  it('never writes the link or the token to a log', async () => {
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => logged.push(...args));
    }
    const fake = seeded();
    const transport = new FakeTransport();

    await offer(fake, ports(transport).ports);
    await offer(fake, ports(transport).ports);
    await offer(fake, ports(transport).ports, NOW_QUIET);
    await offer(seeded({ channel: false }), ports(transport).ports);

    // A positive control: a token really was minted, so the assertion below is about
    // discretion rather than about there being nothing to leak.
    expect(transport.bodies()[0]).toContain('/connect?t=');
    expect(JSON.stringify(logged)).not.toContain('connect?t=');
  });
});
