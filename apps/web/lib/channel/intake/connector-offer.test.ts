import { inspect } from 'node:util';
import { type Database, schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  type ConnectorOfferPorts,
  INTAKE_CONNECTOR_OFFER_TEMPLATE_KEY,
  calendarCardDedupeKey,
  connectorOfferDedupeKey,
  gmailCardDedupeKey,
  sendConnectorOffer,
  sendYearConnectorCards,
} from './connector-offer';
import {
  INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
  INTAKE_GMAIL_CARD_TEMPLATE_KEY,
  intakeConnectorOffer,
} from './copy';
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
    expect(body).toContain('ignore this to skip');
    // One link per connector, each straight into that connector's Google consent.
    const [calendarUrl, gmailUrl] = body.match(/https:\/\/\S+/g) as RegExpMatchArray;
    expect(calendarUrl).toMatch(/\/connect\?t=[A-Za-z0-9_-]+&to=gcal$/);
    expect(gmailUrl).toMatch(/\/connect\?t=[A-Za-z0-9_-]+&to=gmail$/);
    // The whole sentence is the copy module's, links and all — never assembled here.
    expect(body).toBe(intakeConnectorOffer('en', calendarUrl as string, gmailUrl as string));
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
    expect(audits.map((a) => a.actionTaken)).toEqual([
      'connector_link_minted',
      'connector_link_minted',
    ]);
    expect(audits.map((a) => a.after)).toEqual([{ provider: 'gcal' }, { provider: 'gmail' }]);
  });

  it('offers once per family - a second run reaches no provider and mints no second token', async () => {
    const fake = seeded();
    const transport = new FakeTransport();

    await offer(fake, ports(transport).ports);
    const second = await offer(fake, ports(transport).ports);

    expect(second).toEqual({ status: 'not_sent', reason: 'already_sent' });
    expect(transport.sent).toHaveLength(1);
    // Two tokens, one per link — and no third from the run that never reached a mint.
    expect(fake.rows(schema.channelSigninTokens)).toHaveLength(2);
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
   *
   * READ THE WAY CONSOLE WRITES, which is `util.inspect` and not `JSON.stringify`: an
   * Error's message and stack are non-enumerable, so a stringified assertion passes on
   * a line that prints the link in full. The last thing this path touches is the DB
   * write of the body, so the error most likely to reach the catch-all is exactly the
   * one carrying the body — it is driven here on purpose.
   */
  it('never writes the link or the token to a log, whatever threw', async () => {
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
    const threw = await sendConnectorOffer(
      seeded().db,
      { familyId: FAMILY, parentUserId: PARENT, phoneE164: PHONE, language: 'en', now: NOW },
      {
        transport: new FakeTransport(),
        threadMessage: async (_db, input) => {
          throw new Error(`could not record the sentence: ${input.body}`);
        },
      },
    );

    // Positive controls, both ways: a token really was minted, the catch-all really
    // ran, and the reader below really can see a link inside a thrown Error.
    expect(transport.bodies()[0]).toContain('/connect?t=');
    expect(threw).toEqual({ status: 'not_sent', reason: 'send_failed', code: 'unexpected' });
    expect(inspect([new Error('https://app.villagehale.com/connect?t=leaked')])).toContain(
      'connect?t=',
    );
    expect(inspect(logged, { depth: null })).not.toContain('connect?t=');
  });
});

describe('the year-open connector cards', () => {
  function cards(
    fake: FakeDb,
    offerPorts: ConnectorOfferPorts,
    now: Date = NOW,
    ridesReply?: boolean,
  ) {
    return sendYearConnectorCards(
      fake.db,
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        phoneE164: PHONE,
        language: 'en',
        now,
        ...(ridesReply ? { ridesReply } : {}),
      },
      offerPorts,
    );
  }

  it('sends the calendar card, then the Gmail card, one link each', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const { ports: offerPorts, threaded } = ports(transport);

    const outcome = await cards(fake, offerPorts, NOW, true);

    expect(outcome).toEqual({ calendar: 'sent', gmail: 'sent' });
    expect(transport.bodies()).toHaveLength(2);
    const calendar = transport.bodies()[0] as string;
    const gmail = transport.bodies()[1] as string;
    expect(calendar).toContain('Calendar:');
    expect(calendar).not.toContain('Gmail:');
    expect(gmail).toContain('Gmail:');
    expect(gmail).toContain('ignore this to skip');
    expect((calendar.match(/https:\/\/\S+/g) ?? []).length).toBe(1);
    expect((gmail.match(/https:\/\/\S+/g) ?? []).length).toBe(1);
    expect(threaded.map((turn) => turn.body)).toEqual([calendar, gmail]);
    expect(ledgerRows(fake)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: 'insert',
          templateKey: INTAKE_CALENDAR_CARD_TEMPLATE_KEY,
          dedupeKey: calendarCardDedupeKey(FAMILY),
        }),
        expect.objectContaining({
          op: 'insert',
          templateKey: INTAKE_GMAIL_CARD_TEMPLATE_KEY,
          dedupeKey: gmailCardDedupeKey(FAMILY),
        }),
      ]),
    );
  });

  it('holds both cards in quiet hours unless this turn is the reply', async () => {
    const held = seeded();
    const heldTransport = new FakeTransport();
    const quiet = await cards(held, ports(heldTransport).ports, NOW_QUIET);
    expect(quiet).toEqual({
      calendar: 'suppressed_quiet_hours',
      gmail: 'suppressed_quiet_hours',
    });
    expect(heldTransport.sent).toEqual([]);

    const riding = seeded();
    const ridingTransport = new FakeTransport();
    const sent = await cards(riding, ports(ridingTransport).ports, NOW_QUIET, true);
    expect(sent).toEqual({ calendar: 'sent', gmail: 'sent' });
    expect(ridingTransport.sent).toHaveLength(2);
  });

  it('still sends the Gmail card when the calendar card is refused', async () => {
    const fake = seeded();
    const real = new FakeTransport();
    let calls = 0;
    const transport: ChannelTransport = {
      async send(input) {
        calls += 1;
        if (calls === 1) throw new TwilioSendError('21610', 400);
        return real.send(input);
      },
    };

    const outcome = await cards(fake, ports(transport).ports, NOW, true);

    expect(outcome).toEqual({ calendar: 'send_failed', gmail: 'sent' });
    expect(real.bodies()).toHaveLength(1);
    expect(real.bodies()[0]).toContain('Gmail:');
  });
});
