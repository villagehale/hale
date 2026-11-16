import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type ConnectorOfferPorts,
  calendarCardDedupeKey,
  sendYearConnectorCards,
} from './connector-offer';
import { INTAKE_CALENDAR_CARD_TEMPLATE_KEY } from './copy';
import { type ChannelTransport, FakeTransport } from './transport';

/**
 * A card whose link never went is not a sent card (rule #11). The claim row is the
 * receipt and its family-scoped dedupe key is the one offer the family gets, so both are
 * read back from the real schema: the partial unique index is what spends the offer.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const PHONE = '+15555550142';
const NOW = new Date('2026-10-14T17:00:00.000Z');
const CHAT = 'chat-1';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedParent(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Card family', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:card-parent', name: 'Parent', timezone: 'America/Chicago' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PHONE),
    phoneE164Hash: phoneBlindIndex(PHONE),
    verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  return { familyId, parentUserId };
}

/** iMessage: the prose goes; the link text is refused when `refuseLink`. `linkTexts`
 * counts the link-text attempts, so a test can see that path was actually tried. */
function imessageTransport(refuseLink: boolean): ChannelTransport & { linkTexts: number } {
  const real = new FakeTransport();
  return {
    linkTexts: 0,
    async send(input) {
      if (input.body.startsWith('https://')) {
        this.linkTexts += 1;
        if (refuseLink) throw new LinqSendError('21610', 400, true);
      }
      const sent = await real.send(input);
      return { ...sent, transport: 'imessage', chatId: CHAT };
    },
  };
}

/** The Linq preview bubble refused, so the link's only other path is its own text. */
function refusePreview(): ReturnType<typeof vi.fn> {
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  const fetchMock = vi.fn(async () => Response.json({ error: { code: 2001 } }, { status: 400 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function ports(transport: ChannelTransport): ConnectorOfferPorts {
  return { transport, threadMessage: async () => 'conv-1' };
}

function offerCalendar(
  parent: { familyId: string; parentUserId: string },
  transport: ChannelTransport,
) {
  return sendYearConnectorCards(
    db.database,
    {
      ...parent,
      phoneE164: PHONE,
      language: 'en',
      now: NOW,
      ridesReply: true,
      only: 'gcal',
      voice: { gcal: 'Calendar prose (test fixture).' },
    },
    ports(transport),
  );
}

async function calendarClaims(familyId: string) {
  const rows = await db.database
    .select({
      familyId: schema.channelMessages.familyId,
      templateKey: schema.channelMessages.templateKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
  return rows.filter((row) => row.templateKey === INTAKE_CALENDAR_CARD_TEMPLATE_KEY);
}

describe('a connector card whose link never went', () => {
  it('reads failed with link_unsent and releases the family dedupe key', async () => {
    const parent = await seedParent();
    const preview = refusePreview();
    const transport = imessageTransport(true);

    const outcome = await offerCalendar(parent, transport);

    expect(preview).toHaveBeenCalledTimes(1);
    expect(transport.linkTexts).toBe(1);
    expect(outcome.calendar).toBe('send_failed');
    expect(await calendarClaims(parent.familyId)).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: 'link_unsent', dedupeKey: null }),
    ]);
  });

  it('releases the key the same way when the provider refused the card itself', async () => {
    const parent = await seedParent();
    const refused: ChannelTransport = {
      async send() {
        throw new LinqSendError('21610', 400, true);
      },
    };

    const outcome = await offerCalendar(parent, refused);

    expect(outcome.calendar).toBe('send_failed');
    expect(await calendarClaims(parent.familyId)).toEqual([
      expect.objectContaining({ status: 'failed', errorCode: '21610', dedupeKey: null }),
    ]);
  });

  it('can be offered again, and the offer that lands spends the key', async () => {
    const parent = await seedParent();
    refusePreview();
    await offerCalendar(parent, imessageTransport(true));

    const again = await offerCalendar(parent, imessageTransport(false));

    expect(again.calendar).toBe('sent');
    const claims = await calendarClaims(parent.familyId);
    expect(claims).toHaveLength(2);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'failed', errorCode: 'link_unsent', dedupeKey: null }),
        expect.objectContaining({
          status: 'sent',
          errorCode: null,
          dedupeKey: calendarCardDedupeKey(parent.familyId),
        }),
      ]),
    );

    // Positive control: a card that went is the family's one offer.
    const third = await offerCalendar(parent, imessageTransport(false));
    expect(third.calendar).toBe('already_sent');
    expect(await calendarClaims(parent.familyId)).toHaveLength(2);
  });

  it('positive control: the link goes as its own text and the claim stays accepted with the key', async () => {
    const parent = await seedParent();
    const preview = refusePreview();
    const transport = imessageTransport(false);

    const outcome = await offerCalendar(parent, transport);

    expect(preview).toHaveBeenCalledTimes(1);
    expect(transport.linkTexts).toBe(1);
    expect(outcome.calendar).toBe('sent');
    expect(await calendarClaims(parent.familyId)).toEqual([
      expect.objectContaining({
        status: 'sent',
        errorCode: null,
        dedupeKey: calendarCardDedupeKey(parent.familyId),
      }),
    ]);
  });
});
