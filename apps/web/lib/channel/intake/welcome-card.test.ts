import { readFileSync } from 'node:fs';
import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { MARKETING_SITE_URL } from '~/lib/legal-links';
import { type FakeDb, makeFakeDb } from './fakes';
import { type ChannelTransport, FakeTransport } from './transport';
import {
  CONTACT_CARD_URL,
  WELCOME_CARD_BODY,
  WELCOME_CARD_TEMPLATE_KEY,
  type WelcomeCardPorts,
  sendWelcomeContactCard,
  welcomeCardDedupeKey,
} from './welcome-card';

const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const PARENT = '00000000-0000-4000-8000-0000000000a1';
const PHONE = '+14165551234';
const NOW = new Date('2026-08-26T12:00:00.000Z');

type Threaded = Array<{ familyId: string; parentUserId: string; body: string }>;

function ports(transport: ChannelTransport): { ports: WelcomeCardPorts; threaded: Threaded } {
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

/** A provider that refuses every send with the given Twilio code. */
function refusing(code: string): ChannelTransport {
  return {
    async send() {
      throw new TwilioSendError(code, 400);
    },
  };
}

function send(fake: FakeDb, cardPorts: WelcomeCardPorts) {
  return sendWelcomeContactCard(
    fake.db,
    { familyId: FAMILY, parentUserId: PARENT, phoneE164: PHONE, now: NOW },
    cardPorts,
  );
}

function ledgerRows(fake: FakeDb) {
  return fake.writes
    .filter((w) => w.op === 'insert' && w.table === schema.channelMessages)
    .map((w) => w.payload);
}

describe('the welcome contact card', () => {
  it('points at the vCard route apps/site actually serves', () => {
    // The MediaUrl is fetched by TWILIO, from the public marketing origin — not the app
    // domain, and not the apex (which 308s). A route moved without this line moving is a
    // media fetch that fails and takes the whole message down with it (verified live:
    // an unfetchable MediaUrl fails the message at error_code 11200, body included).
    expect(CONTACT_CARD_URL).toBe(`${MARKETING_SITE_URL}/hale.vcf`);
    const route = readFileSync(new URL('../../../../site/app/hale.vcf/route.ts', import.meta.url));
    expect(route.toString()).toContain('text/vcard');
  });

  it('sends ONE MMS carrying the card, threads it, and ledgers it against the family', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();
    const { ports: cardPorts, threaded } = ports(transport);

    const outcome = await send(fake, cardPorts);

    expect(outcome).toEqual({ status: 'sent', channelMessageId: expect.any(String) });
    expect(transport.sent).toEqual([
      { to: PHONE, body: WELCOME_CARD_BODY, mediaUrls: [CONTACT_CARD_URL] },
    ]);
    // The thread carries the sentence, so the coach can see Hale introduced itself.
    expect(threaded).toEqual([{ familyId: FAMILY, parentUserId: PARENT, body: WELCOME_CARD_BODY }]);

    const [row] = ledgerRows(fake);
    expect(row).toMatchObject({
      familyId: FAMILY,
      parentUserId: PARENT,
      channel: 'sms',
      direction: 'out',
      category: 'intake',
      templateKey: WELCOME_CARD_TEMPLATE_KEY,
      dedupeKey: welcomeCardDedupeKey(FAMILY),
      status: 'queued',
    });
    // Rule #6: the send has its own audit row.
    const audits = fake.writes.filter((w) => w.table === schema.auditLog).map((w) => w.payload);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ familyId: FAMILY, actionTaken: 'intake_welcome_card_sent' });
  });

  it('sends the card at most once per family, ever — a second run reaches no provider', async () => {
    const fake = makeFakeDb();
    const transport = new FakeTransport();

    await send(fake, ports(transport).ports);
    const second = await send(fake, ports(transport).ports);

    expect(second).toEqual({ status: 'not_sent', reason: 'already_sent' });
    expect(transport.sent).toHaveLength(1);
    expect(ledgerRows(fake)).toHaveLength(1);
  });

  it('counts a refused card as a FAILED send with the provider code, and never a silent drop', async () => {
    const fake = makeFakeDb();
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => errors.push(...args));
    const { ports: cardPorts, threaded } = ports(refusing('21620'));

    const outcome = await send(fake, cardPorts);

    expect(outcome).toEqual({
      status: 'not_sent',
      reason: 'send_failed',
      code: '21620',
      permanent: true,
    });
    // The failure is WRITTEN DOWN, not just returned: the row it claimed says why.
    const updates = fake.writes.filter(
      (w) => w.op === 'update' && w.table === schema.channelMessages,
    );
    expect(updates.map((w) => w.payload)).toEqual([{ status: 'failed', errorCode: '21620' }]);
    // Nothing reached the parent, so nothing goes in the thread either.
    expect(threaded).toEqual([]);
    expect(JSON.stringify(errors)).toContain('21620');
    vi.restoreAllMocks();
  });

  it('does not re-send after a refusal — a consumed key stays consumed', async () => {
    const fake = makeFakeDb();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(fake, ports(refusing('21620')).ports);
    vi.restoreAllMocks();

    const transport = new FakeTransport();
    const second = await send(fake, ports(transport).ports);

    expect(second).toEqual({ status: 'not_sent', reason: 'already_sent' });
    expect(transport.sent).toEqual([]);
  });
});
