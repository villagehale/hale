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

  it('sends the calendar card, then the Gmail card, each link once as its own text', async () => {
    const fake = seeded();
    const transport = new FakeTransport();
    const { ports: offerPorts, threaded } = ports(transport);

    const outcome = await cards(fake, offerPorts, NOW, true);

    expect(outcome).toEqual({ calendar: 'sent', gmail: 'sent' });
    const [calendar, calendarLink, gmail, gmailLink] = transport.bodies() as string[];
    expect(transport.bodies()).toHaveLength(4);
    expect(calendar).toBe('Calendar prose (test fixture).');
    expect(gmail).toBe('Gmail prose (test fixture).');
    expect(calendarLink).toMatch(/^https:\/\/\S+\/connect\?t=\S+$/);
    expect(gmailLink).toMatch(/^https:\/\/\S+\/connect\?t=\S+$/);
    expect(calendarLink).not.toBe(gmailLink);
    expect(threaded.map((turn) => turn.body)).toEqual([
      `${calendar}\n${calendarLink}`,
      `${gmail}\n${gmailLink}`,
    ]);
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
    expect(ridingTransport.sent).toHaveLength(4);
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
    expect(real.bodies()).toHaveLength(2);
    expect(real.bodies()[0]).toBe('Gmail prose (test fixture).');
  });

  describe('on iMessage the link goes out once', () => {
    const CHAT = 'chat-1';
    function imessageTransport(): { transport: ChannelTransport; real: FakeTransport } {
      const real = new FakeTransport();
      return {
        real,
        transport: {
          async send(input) {
            const sent = await real.send(input);
            return { ...sent, transport: 'imessage', chatId: CHAT };
          },
        },
      };
    }
    function linqFetch(status: number) {
      return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        status === 201
          ? Response.json({ message: { id: 'link-1' } }, { status })
          : Response.json({ error: { code: 2001 } }, { status }),
      );
    }
    function linkParts(fetchMock: ReturnType<typeof linqFetch>): string[] {
      return fetchMock.mock.calls.flatMap((call) => {
        const body = JSON.parse(String(call[1]?.body ?? '{}')) as {
          message?: { parts?: Array<{ type: string; value: string }> };
        };
        return (body.message?.parts ?? []).filter((p) => p.type === 'link').map((p) => p.value);
      });
    }
    function urlsIn(texts: string[]): string[] {
      return texts.flatMap((text) => text.match(/https?:\/\/\S+/g) ?? []);
    }
    function offer(fake: FakeDb, offerPorts: ConnectorOfferPorts) {
      return sendYearConnectorCards(
        fake.db,
        {
          familyId: FAMILY,
          parentUserId: PARENT,
          phoneE164: PHONE,
          language: 'en',
          now: NOW,
          ridesReply: true,
          only: 'gcal',
          voice: { gcal: 'Calendar prose (test fixture).' },
        },
        offerPorts,
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('sends the prose without the URL, then the preview bubble', async () => {
      vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
      const fetchMock = linqFetch(201);
      vi.stubGlobal('fetch', fetchMock);
      const fake = seeded();
      const { transport, real } = imessageTransport();

      const outcome = await offer(fake, ports(transport).ports);

      expect(outcome.calendar).toBe('sent');
      const links = linkParts(fetchMock);
      expect(links).toHaveLength(1);
      expect(links[0]).toContain('/connect?t=');
      expect(real.bodies()).toEqual(['Calendar prose (test fixture).']);
      expect([...urlsIn(real.bodies()), ...links]).toHaveLength(1);
    });

    it('sends the URL as its own text when the preview is refused', async () => {
      vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
      const fetchMock = linqFetch(400);
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fake = seeded();
      const { transport, real } = imessageTransport();

      const outcome = await offer(fake, ports(transport).ports);

      expect(outcome.calendar).toBe('sent');
      expect(real.bodies()).toHaveLength(2);
      expect(real.bodies()[0]).toBe('Calendar prose (test fixture).');
      expect(real.bodies()[1]).toMatch(/^https:\/\/\S+\/connect\?t=\S+$/);
      expect(urlsIn(real.bodies())).toHaveLength(1);
    });
  });

  it('names the card unsent when the prose went but its link did not', async () => {
    const fake = seeded();
    const real = new FakeTransport();
    const transport: ChannelTransport = {
      async send(input) {
        if (input.body.startsWith('https://')) throw new LinqSendError('21610', 400, true);
        return real.send(input);
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});

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
        voice: { gcal: 'Calendar prose (test fixture).' },
      },
      ports(transport).ports,
    );

    expect(outcome.calendar).toBe('send_failed');
    expect(real.bodies()).toEqual(['Calendar prose (test fixture).']);
  });

  it('sends friend-voice prose, then the minted calendar link', async () => {
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
    expect(transport.bodies()[0]).toBe(prose);
    expect(transport.bodies()[1]).toContain('/connect?t=');
  });
});
