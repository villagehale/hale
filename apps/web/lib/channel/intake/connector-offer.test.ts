import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  type ConnectorOfferPorts,
  calendarCardDedupeKey,
  gmailCardDedupeKey,
  sendYearConnectorCards,
} from './connector-offer';
import { INTAKE_CALENDAR_CARD_TEMPLATE_KEY, INTAKE_GMAIL_CARD_TEMPLATE_KEY } from './copy';
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
        voice: { gcal: 'Calendar prose (test fixture).', gmail: 'Gmail prose (test fixture).' },
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
    expect(calendar).not.toContain('Gmail');
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
        if (calls === 1) throw new LinqSendError('21610', 400, true);
        return real.send(input);
      },
    };

    const outcome = await cards(fake, ports(transport).ports, NOW, true);

    expect(outcome).toEqual({ calendar: 'send_failed', gmail: 'sent' });
    expect(real.bodies()).toHaveLength(1);
  });

  it('sends friend-voice prose with the minted calendar link attached', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const prose = 'Want me to check your calendar? This link is just for you.';
    const outcome = await sendYearConnectorCards(
      fake.db,
      {
        familyId: FAMILY,
        parentUserId: PARENT,
        phoneE164: PHONE,
        language: 'en',
        now: NOW,
        ridesReply: true,
        only: 'gcal',
        voice: { gcal: prose },
      },
      ports(transport).ports,
    );
    expect(outcome.calendar).toBe('sent');
    const body = transport.bodies()[0] ?? '';
    expect(body).toContain(prose);
    expect(body).toContain('/connect?t=');
    expect(body).not.toContain('Connect your calendar:');
  });
});
