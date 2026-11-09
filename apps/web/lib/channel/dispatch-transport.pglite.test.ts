import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSmsChannel } from '~/lib/channel/adapters/phone-sms';
import { dispatchLoopMessage } from '~/lib/channel/dispatch';
import { fakeRenderer } from '~/lib/channel/fakes';
import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import type { TemplateRenderer } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { LoopMessage } from './types';

/**
 * The ledger row a loop send writes names the pipe that carried it. A parent's PIPEDA
 * access request reads channel_messages, so a reminder that went out by iMessage must not
 * read back as an SMS. Through the production ports and the real adapter, because the
 * pipe is known only at the adapter and the row is written only by the dispatch.
 */

const KEY = Buffer.alloc(32, 5).toString('base64');
const PHONE = '+15555550147';
const NOON = new Date('2026-10-14T17:00:00.000Z');

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
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedParent(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Transport family', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:transport-parent', name: 'Parent', timezone: 'America/Chicago' })
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

/** A transport that names its pipe, the way the Linq transport does. */
function namingTransport(named: 'imessage' | null): ChannelTransport & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    async send(input) {
      sent.push(input);
      return named
        ? { providerMessageId: 'linq-1', transport: named, chatId: 'chat-1' }
        : { providerMessageId: 'sms-1' };
    },
  };
}

/** Two texts in one message, the shape the reminder template renders. */
const twoTextRenderer: TemplateRenderer = {
  render() {
    return { kind: 'sms', text: 'first\n\nsecond', texts: ['first', 'second'], modelWritten: true };
  },
};

async function sendOne(transport: ChannelTransport, renderer: TemplateRenderer = fakeRenderer) {
  const { familyId, parentUserId } = await seedParent();
  const ports = buildDispatchPorts(db.database, {
    channels: {
      sms: createSmsChannel({ resolveTarget: async () => PHONE, configured: true, transport }),
    },
    renderer,
    now: () => NOON,
  });
  const msg: LoopMessage = {
    templateKey: 'reminder_test',
    familyId,
    parentUserId,
    category: 'approval',
    urgency: 'normal',
    payload: {},
    dedupeKey: 'transport-test',
  };
  const result = await dispatchLoopMessage(msg, ports);
  const rows = await db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
  const audits = await db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return { result, rows, audits };
}

describe('the loop ledger records the transport actually used', () => {
  it('an iMessage-resolved send writes channel imessage, with its chat and terminal status', async () => {
    const transport = namingTransport('imessage');
    const { result, rows, audits } = await sendOne(transport);

    expect(transport.sent).toHaveLength(1);
    expect(result.legs).toEqual([{ channel: 'sms', outcome: 'sent' }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'imessage',
      status: 'sent',
      providerMessageId: 'linq-1',
      providerChatId: 'chat-1',
      dedupeKey: 'transport-test:sms',
    });
    expect(audits.map((a) => (a.after as { channel: string }).channel)).toEqual(['imessage']);
  });

  it('a send on a transport that names no pipe stays an SMS row (positive control)', async () => {
    const { rows, audits } = await sendOne(namingTransport(null));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'sms', status: 'queued', providerMessageId: 'sms-1' });
    expect(audits.map((a) => (a.after as { channel: string }).channel)).toEqual(['sms']);
  });

  it('a multi-text send ledgers every text as imessage, with its chat', async () => {
    const transport = namingTransport('imessage');
    const { rows, audits } = await sendOne(transport, twoTextRenderer);

    expect(transport.sent).toHaveLength(2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        channel: 'imessage',
        status: 'sent',
        providerMessageId: 'linq-1',
        providerChatId: 'chat-1',
      });
    }
    expect(audits.map((a) => (a.after as { channel: string }).channel)).toEqual([
      'imessage',
      'imessage',
    ]);
  });

  it('a multi-text send on a transport that names no pipe stays SMS (positive control)', async () => {
    const { rows, audits } = await sendOne(namingTransport(null), twoTextRenderer);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ channel: 'sms', status: 'queued', providerMessageId: 'sms-1' });
    }
    expect(audits.map((a) => (a.after as { channel: string }).channel)).toEqual(['sms', 'sms']);
  });
});
