import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CO_PARENT_REDIRECT } from '~/lib/channel/caregiver/copy';
import {
  INVITE_SILENCE_MS,
  declineOpenInviteOnStop,
  loadLapsedInviteByPhone,
  loadOpenInviteByPhone,
  loadPendingAssent,
  startCaregiverInvite,
  startCoParentInvite,
} from '~/lib/channel/caregiver/invites';
import { handleKnownNumberInbound } from '~/lib/channel/caregiver/route';
import {
  CO_PARENT_INVITE_CONSENT_SCOPE,
  acceptCoParentInvite,
} from '~/lib/channel/coparent/accept';
import { coParentInviteSentAck } from '~/lib/channel/coparent/copy';
import { INTAKE_COPARENT_ASK_TEMPLATE_KEY } from '~/lib/channel/intake/copy';
import {
  FakeExtractor,
  FakeIdentityAsk,
  FakeIntentReader,
  fakeNoOpenQuestions,
  fakeRadar,
  fakeSilentAnswerComposer,
} from '~/lib/channel/intake/fakes';
import { handleInboundSms } from '~/lib/channel/intake/machine';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { askWriter, writtenAsk, yesNoReader } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  SMS_COPARENT_INVITE_TEMPLATE_KEY,
  deliverCoParentNumberInvite,
  parseCoParentNumberReply,
} from './coparent-invite';
import { LinqSendError } from './transport';

/**
 * A number after the co-parent ask. SMS still texts the locked invite. Linq
 * does not note the number and does not send a second bubble: the co-parent
 * ask already told the parent how to start the group.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550111';
const COPARENT_PHONE = '+19055550182';
const FROM = '+16462352164';
const NOW = new Date('2026-09-24T03:55:00.000Z');
const CHAT = 'chat-parent-1';
const OTHER_PARENT_PHONE = '+14165550122';
const NEVER_INVITED_PHONE = '+14165550133';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Linq must not be called for a co-parent number');
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedHousehold(name = 'Jimmy'): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Jimmy + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${family?.id}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: phoneBlindIndex(PARENT_PHONE),
    verifiedAt: NOW,
  });
  return { familyId, parentUserId };
}

async function seedOtherHousehold(): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Robin + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:robin-${family?.id}`, name: 'Robin' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

async function seedAsk(
  seeded: { familyId: string; parentUserId: string },
  channel: 'imessage' | 'sms',
): Promise<string> {
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channel,
      direction: 'in',
      category: 'reply',
      providerMessageId: `in-${channel}-${seeded.parentUserId}`,
      providerChatId: channel === 'imessage' ? CHAT : null,
      status: 'delivered',
      body: '9055550182',
      sentAt: NOW,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel,
    direction: 'out',
    category: 'reply',
    templateKey: INTAKE_COPARENT_ASK_TEMPLATE_KEY,
    providerMessageId: `ask-${channel}-${seeded.parentUserId}`,
    providerChatId: channel === 'imessage' ? CHAT : null,
    status: 'delivered',
    sentAt: NOW,
  });
  return inbound?.id as string;
}

async function inviteStates(): Promise<string[]> {
  const rows = await db.database
    .select({ state: schema.caregiverInvites.state })
    .from(schema.caregiverInvites);
  return rows.map((row) => row.state);
}

async function grantRows(familyId: string): Promise<number> {
  const rows = await db.database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'co_parent_access_grant'),
        eq(schema.consentRecords.granted, true),
      ),
    );
  return rows.length;
}

async function inviteLedgerRows(): Promise<number> {
  const rows = await db.database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY));
  return rows.length;
}

async function auditVerbs(): Promise<string[]> {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog);
  return rows.map((row) => row.actionTaken);
}

/** A real write failure at the table, not a fake of the function under test. */
async function failInserts(table: string, when = 'true'): Promise<void> {
  await db.exec(`
    create or replace function fail_insert_for_test() returns trigger as $$
    begin
      raise exception 'write failed for test';
    end;
    $$ language plpgsql;
    create trigger fail_insert_for_test before insert on ${table}
      for each row when (${when}) execute function fail_insert_for_test();
  `);
}

async function restoreInserts(table: string): Promise<void> {
  await db.exec(`drop trigger if exists fail_insert_for_test on ${table};`);
}

async function groupChatId(): Promise<string | null> {
  const [family] = await db.database
    .select({ linqGroupChatId: schema.families.linqGroupChatId })
    .from(schema.families);
  return family?.linqGroupChatId ?? null;
}

describe('parseCoParentNumberReply', () => {
  it('reads the sandbox number and a name in front of one', () => {
    expect(parseCoParentNumberReply('9055550182')).toEqual({
      phoneE164: COPARENT_PHONE,
      name: null,
    });
    expect(parseCoParentNumberReply('Sam 905-555-0182')).toEqual({
      phoneE164: COPARENT_PHONE,
      name: 'Sam',
    });
  });

  it('leaves a name and a sentence for the other handlers', () => {
    expect(parseCoParentNumberReply('Jimmy')).toBeNull();
    expect(parseCoParentNumberReply('the school line is 9055550182')).toBeNull();
  });
});

describe('a number on the Linq door', () => {
  it('does not note the number or send a second bubble', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const sendSms = vi.fn();

    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9055550182',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });

    expect(sendSms).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 'not_pending' });
    expect(await inviteStates()).toEqual([]);
    expect(await groupChatId()).toBeNull();
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog);
    expect(audits.map((row) => row.actionTaken)).not.toContain('co_parent_identity_noted');
    expect(audits.map((row) => row.actionTaken)).not.toContain('co_parent_sms_outbound');
  });

  it('stays quiet when Hale has no line and when the SMS flag is dark', async () => {
    vi.stubEnv('LINQ_FROM_E164', '');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'imessage');
    const send = {
      ...seeded,
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms: vi.fn(),
    };
    expect(await deliverCoParentNumberInvite(db.database, { ...send, body: 'Jimmy' })).toEqual({
      status: 'not_pending',
    });
    vi.stubEnv('F14_ENABLED', '');
    expect(await deliverCoParentNumberInvite(db.database, { ...send, body: '9055550182' })).toEqual(
      { status: 'not_pending' },
    );
    expect(await inviteStates()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('a number on the SMS door', () => {
  it('still texts the locked SMS body when the Linq group flag is on', async () => {
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_invite_flag' }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9055550182',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
      ask: askWriter(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: COPARENT_PHONE,
        body: writtenAsk({ kind: 'coparent_invite', inviterName: 'Jimmy', language: 'en' }),
      }),
    );
    expect(outcome.status).toBe('sent');
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await groupChatId()).toBeNull();
  });

  it('texts the locked SMS body and does not call Linq', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_invite' }));
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9055550182',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
      ask: askWriter(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        to: COPARENT_PHONE,
        body: writtenAsk({ kind: 'coparent_invite', inviterName: 'Jimmy', language: 'en' }),
      }),
    );
    expect(outcome).toEqual({
      status: 'sent',
      reply: await coParentInviteSentAck('them', 'en'),
      templateKey: 'coparent:number_invite_ack',
    });
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        templateKey: schema.channelMessages.templateKey,
        channel: schema.channelMessages.channel,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.templateKey, SMS_COPARENT_INVITE_TEMPLATE_KEY));
    expect(row).toMatchObject({ status: 'queued', channel: 'sms' });
    expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    expect(await groupChatId()).toBeNull();
  });

  it('does not skip a YES the add-command is still waiting on', async () => {
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    await db.database.insert(schema.caregiverInvites).values({
      familyId: seeded.familyId,
      invitedByUserId: seeded.parentUserId,
      role: 'co_parent',
      displayName: 'Sam',
      phoneE164Encrypted: encryptString('+16475550199'),
      phoneE164Hash: phoneBlindIndex('+16475550199'),
      state: 'awaiting_parent_assent',
      expiresAt: new Date(NOW.getTime() + 72 * 60 * 60 * 1000),
      createdAt: NOW,
    });
    const sendSms = vi.fn();
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9055550182',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });
    expect(outcome).toEqual({ status: 'not_pending' });
    expect(sendSms).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
  });

  describe('VIL-719 the parent yes is on record before anyone is texted', () => {
    const CLAIM_LOST_TRIGGER = 'lose_invite_claim_for_test';

    afterEach(async () => {
      await restoreInserts('consent_records');
      await restoreInserts('channel_messages');
      await db.exec(`drop trigger if exists ${CLAIM_LOST_TRIGGER} on caregiver_invites;`);
    });

    async function seedTurn() {
      const seeded = await seedHousehold();
      const inboundId = await seedAsk(seeded, 'sms');
      const turn = {
        ...seeded,
        body: '9055550182',
        now: NOW,
        inboundChannelMessageId: inboundId,
        ask: askWriter(),
      };
      return { seeded, turn };
    }

    it('policy on: the consent row exists at the moment the text leaves', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const grantsAtSend: number[] = [];
      const sendSms = vi.fn(async () => {
        grantsAtSend.push(await grantRows(seeded.familyId));
        return { providerMessageId: 'SM_recorded_first' };
      });
      const outcome = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      expect(grantsAtSend).toEqual([1]);
      expect(outcome).toEqual({
        status: 'sent',
        reply: await coParentInviteSentAck('them', 'en'),
        templateKey: 'coparent:number_invite_ack',
      });
      expect(await grantRows(seeded.familyId)).toBe(1);
      expect(await inviteLedgerRows()).toBe(1);
      expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
    });

    it('policy off: today’s order, the text leaves before the consent row', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
      const { seeded, turn } = await seedTurn();
      const grantsAtSend: number[] = [];
      const sendSms = vi.fn(async () => {
        grantsAtSend.push(await grantRows(seeded.familyId));
        return { providerMessageId: 'SM_today' };
      });
      const outcome = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      expect(grantsAtSend).toEqual([0]);
      expect(outcome.status).toBe('sent');
      expect(await grantRows(seeded.familyId)).toBe(1);
    });

    it('policy on: a yes that cannot be written texts no one, and the re-drive finishes it', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_after_redrive' }));

      await failInserts('consent_records');
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      expect(sendSms).not.toHaveBeenCalled();
      expect(await grantRows(seeded.familyId)).toBe(0);
      expect(await inviteLedgerRows()).toBe(0);
      expect(await inviteStates()).toEqual(['superseded']);

      await restoreInserts('consent_records');
      const redriven = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      expect(redriven.status).toBe('sent');
      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(sendSms).toHaveBeenCalledWith({
        to: COPARENT_PHONE,
        body: writtenAsk({ kind: 'coparent_invite', inviterName: 'Jimmy', language: 'en' }),
        sendKey: expect.stringMatching(/^co_parent_invite:/),
      });
      expect(await grantRows(seeded.familyId)).toBe(1);
      expect(await inviteLedgerRows()).toBe(1);
      expect((await inviteStates()).sort()).toEqual(['awaiting_caregiver_reply', 'superseded']);
    });

    it.each([
      ['a plain error', () => new Error('linq timed out')],
      ['a timeout', () => new LinqSendError('timeout', 0, false)],
      ['a 503', () => new LinqSendError('http_503', 503, false)],
      ['a 409', () => new LinqSendError('http_409', 409, true)],
      ['a certain refusal', () => new LinqSendError('http_422', 422, true)],
    ])(
      'policy on: after %s the invite waits on the parent, and the redelivered turn sends under the same key',
      async (_name, failure) => {
        vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
        const { seeded, turn } = await seedTurn();
        const err = failure();
        const sendSms = vi
          .fn(async (_sms: { to: string; body: string; sendKey?: string }) => ({
            providerMessageId: 'SM_second_attempt',
          }))
          .mockRejectedValueOnce(err);

        await expect(deliverCoParentNumberInvite(db.database, { ...turn, sendSms })).rejects.toBe(
          err,
        );
        expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
        expect(await grantRows(seeded.familyId)).toBe(1);
        expect(await inviteLedgerRows()).toBe(0);
        expect(await auditVerbs()).toContain('co_parent_invite_send_failed');
        const pending = await loadPendingAssent(db.database, seeded.parentUserId, NOW);
        expect(pending?.phoneE164).toBe(COPARENT_PHONE);

        const redriven = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });

        expect(redriven).toEqual({
          status: 'sent',
          reply: await coParentInviteSentAck('them', 'en'),
          templateKey: 'coparent:number_invite_ack',
        });
        expect(sendSms).toHaveBeenCalledTimes(2);
        const key = `co_parent_invite:${pending?.id}`;
        expect(sendSms.mock.calls[0]?.[0].sendKey).toBe(key);
        expect(sendSms.mock.calls[1]?.[0].sendKey).toBe(key);
        expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
        expect(await grantRows(seeded.familyId)).toBe(1);
        expect(await inviteLedgerRows()).toBe(1);
      },
    );

    it('policy on: while the invite waits, asking for that number again re-asks and never says Hale texted them', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      const [waiting] = await db.database
        .select({ id: schema.caregiverInvites.id })
        .from(schema.caregiverInvites);

      const again = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });

      expect(again).toMatchObject({
        status: 'started',
        invite: { id: waiting?.id, state: 'awaiting_parent_assent' },
        reply: writtenAsk({ kind: 'coparent_scope', name: 'Sam', language: 'en' }),
      });
      expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
    });

    it('positive control, policy on: a number Hale did text still reads as already invited', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      await deliverCoParentNumberInvite(db.database, {
        ...turn,
        sendSms: vi.fn(async () => ({ providerMessageId: 'SM_landed' })),
      });
      const again = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(again).toEqual({ status: 'refused', reason: 'already_invited' });
    });

    it('policy on: a caregiver add for the waiting number replaces the row and a stop still binds it', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();

      const added = await startCaregiverInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        parsed: { ok: true, role: 'nanny', name: 'Sam', phoneE164: COPARENT_PHONE },
        now: NOW,
        ask: askWriter(),
      });

      expect(added.status).toBe('started');
      expect((await inviteStates()).sort()).toEqual(['awaiting_parent_assent', 'expired_unsent']);

      expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, NOW)).toBe(true);
      const again = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(again).toMatchObject({ status: 'refused', reason: 'previously_declined' });
    });

    it('policy on: a waiting row the parent moved on from can still be refused by a stop', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      const moved = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Robin', phoneE164: NEVER_INVITED_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(moved.status).toBe('started');

      expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, NOW)).toBe(true);

      const again = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(again).toMatchObject({ status: 'refused', reason: 'previously_declined' });
    });

    it('policy on: a re-drive whose claim fails leaves the row waiting, so a stop still binds it', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      await db.exec(`
        create or replace function fail_reclaim_for_test() returns trigger as $$
        begin
          raise exception 'reclaim failed for test';
        end;
        $$ language plpgsql;
        create trigger fail_reclaim_for_test before update on caregiver_invites
          for each row when (new.state = 'awaiting_caregiver_reply')
          execute function fail_reclaim_for_test();
      `);

      try {
        await expect(
          deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
        ).rejects.toThrow('reclaim failed');
      } finally {
        await db.exec('drop trigger fail_reclaim_for_test on caregiver_invites;');
      }

      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
      expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, NOW)).toBe(true);
      expect(await inviteStates()).toEqual(['declined']);
    });

    it('policy on: a row that could not be put back pages #ops and the send error still surfaces', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://slack.invalid/hook');
      vi.stubEnv('OPS_SLACK_CHANNEL', '#ops');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const posts: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: { body: string }) => {
          posts.push(init.body);
          return new Response('ok');
        }),
      );
      const { turn } = await seedTurn();
      const err = new LinqSendError('timeout', 0, false);
      const sendSms = vi.fn(async () => {
        throw err;
      });
      await db.exec(`
        create or replace function fail_settle_for_test() returns trigger as $$
        begin
          raise exception 'settle failed for test';
        end;
        $$ language plpgsql;
        create trigger fail_settle_for_test before update on caregiver_invites
          for each row when (old.state = 'awaiting_caregiver_reply' and new.state = 'awaiting_parent_assent')
          execute function fail_settle_for_test();
      `);

      try {
        await expect(deliverCoParentNumberInvite(db.database, { ...turn, sendSms })).rejects.toBe(
          err,
        );
      } finally {
        await db.exec('drop trigger fail_settle_for_test on caregiver_invites;');
      }

      expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain('co_parent_invite_unsettled');
    });

    it('positive control, policy on: a row put back cleanly pages nobody', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://slack.invalid/hook');
      vi.stubEnv('OPS_SLACK_CHANNEL', '#ops');
      const posts: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: { body: string }) => {
          posts.push(init.body);
          return new Response('ok');
        }),
      );
      const { turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
      expect(posts).toEqual([]);
    });

    it('policy on: a waiting invite blocks a re-invite to that number from another family', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();

      const other = await seedOtherHousehold();
      const started = await startCoParentInvite(db.database, {
        familyId: other.familyId,
        invitedByUserId: other.parentUserId,
        inviterPhoneE164: OTHER_PARENT_PHONE,
        inviterName: 'Robin',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(started).toEqual({ status: 'refused', reason: 'unavailable' });
    });

    it('policy on: the person’s stop closes a waiting invite and suppresses the number', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();

      expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, NOW)).toBe(true);
      expect(await inviteStates()).toEqual(['declined']);
      const again = await startCoParentInvite(db.database, {
        familyId: seeded.familyId,
        invitedByUserId: seeded.parentUserId,
        inviterPhoneE164: PARENT_PHONE,
        inviterName: 'Jimmy',
        parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
        language: 'en',
        now: NOW,
        ask: askWriter(),
      });
      expect(again).toMatchObject({ status: 'refused', reason: 'previously_declined' });
    });

    it('policy on: a waiting invite that lapses tells nobody it expired and a stop still closes it', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { turn } = await seedTurn();
      const sendSms = vi.fn(async () => {
        throw new LinqSendError('timeout', 0, false);
      });
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();

      const late = new Date(NOW.getTime() + INVITE_SILENCE_MS + 60_000);
      expect(await loadOpenInviteByPhone(db.database, COPARENT_PHONE, late)).toBeNull();
      expect(await inviteStates()).toEqual(['expired_unsent']);
      expect(await loadLapsedInviteByPhone(db.database, COPARENT_PHONE, late)).toBeNull();

      expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, late)).toBe(true);
      expect(await inviteStates()).toEqual(['declined']);
    });

    it('policy on: an invite’s text carries that invite’s own provider key', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { turn } = await seedTurn();
      const sendSms = vi.fn(async (_sms: { to: string; body: string; sendKey?: string }) => ({
        providerMessageId: 'SM_first',
      }));
      await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      const [row] = await db.database
        .select({ id: schema.caregiverInvites.id })
        .from(schema.caregiverInvites);
      expect(sendSms.mock.calls[0]?.[0].sendKey).toBe(`co_parent_invite:${row?.id}`);
    });

    async function answerFrom(
      phone: string,
      body: string,
      providerId: string,
      intent: 'none' | 'crisis_mental' = 'none',
      transport = new FakeTransport(),
    ) {
      const outcome = await handleInboundSms(
        db.database,
        transport.inbound(phone, body, { providerId, receivedAt: NOW }),
        {
          transport,
          threadMessage: async () => 'conv-1',
          openQuestions: fakeNoOpenQuestions,
          extractor: new FakeExtractor([{ children: [], postalCode: null }]),
          intentReader: new FakeIntentReader([]),
          radar: fakeRadar,
          answerComposer: fakeSilentAnswerComposer,
          identityAsk: new FakeIdentityAsk(),
          limiter: new FakeRateLimiter(() => NOW.getTime()),
          optOutReader: { read: async () => ({ intent, confirmation: '', language: 'en' }) },
          consent: yesNoReader(),
          consentAsk: askWriter(),
          now: NOW,
        },
      );
      return { outcome, bodies: transport.bodies() };
    }

    async function memberRoles(familyId: string): Promise<string[]> {
      const rows = await db.database
        .select({ role: schema.familyMembers.role })
        .from(schema.familyMembers)
        .where(eq(schema.familyMembers.familyId, familyId));
      return rows.map((row) => row.role).sort();
    }

    async function inviteReplyConsents(): Promise<number> {
      const rows = await db.database
        .select({ id: schema.consentRecords.id })
        .from(schema.consentRecords)
        .where(eq(schema.consentRecords.consentScope, CO_PARENT_INVITE_CONSENT_SCOPE));
      return rows.length;
    }

    it.each(['yes', 'maybe later'])(
      'policy on: "%s" while the invite waits binds nothing and is answered as a new number is',
      async (answer) => {
        vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
        const { seeded, turn } = await seedTurn();
        const sendSms = vi.fn(async () => {
          throw new LinqSendError('timeout', 0, false);
        });
        await expect(
          deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
        ).rejects.toThrow();

        const stranger = await answerFrom(NEVER_INVITED_PHONE, answer, `in-stranger-${answer}`);
        const waiting = await answerFrom(COPARENT_PHONE, answer, `in-waiting-${answer}`);

        expect(waiting.outcome.status).toBe(stranger.outcome.status);
        expect(waiting.bodies).toEqual(stranger.bodies);
        expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
        expect(await memberRoles(seeded.familyId)).toEqual(['primary_parent']);
        expect(await inviteReplyConsents()).toBe(0);
      },
    );

    it('positive control, policy on: a yes to an invite Linq accepted seats them', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_landed' }));
      await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });

      const { outcome } = await answerFrom(COPARENT_PHONE, 'yes', 'in-confirmed-yes');

      expect(outcome.status).toBe('co_parent_accepted');
      expect(await inviteStates()).toEqual(['accepted']);
      expect(await memberRoles(seeded.familyId)).toEqual(['co_parent', 'primary_parent']);
      expect(await inviteReplyConsents()).toBe(1);
    });

    it('policy on: an invite put back before the yes is claimed seats nobody', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_landed' }));
      await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      const invite = await loadOpenInviteByPhone(db.database, COPARENT_PHONE, NOW);
      if (invite?.role !== 'co_parent') throw new Error('expected an open co-parent invite');
      await db.database
        .update(schema.caregiverInvites)
        .set({ state: 'awaiting_parent_assent' })
        .where(eq(schema.caregiverInvites.id, invite.id));

      const seated = await acceptCoParentInvite(db.database, {
        invite,
        verbatimReply: 'yes',
        now: NOW,
      });

      expect(seated.outcome).toBe('lost_race');
      expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
      expect(await memberRoles(seeded.familyId)).toEqual(['primary_parent']);
      expect(await inviteReplyConsents()).toBe(0);
    });

    it('policy on: a ledger write that fails after the text left does not text it again', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_landed' }));

      await failInserts(
        'channel_messages',
        `new.template_key = '${SMS_COPARENT_INVITE_TEMPLATE_KEY}'`,
      );
      await expect(
        deliverCoParentNumberInvite(db.database, { ...turn, sendSms }),
      ).rejects.toThrow();
      expect(sendSms).toHaveBeenCalledTimes(1);
      expect(await grantRows(seeded.familyId)).toBe(1);
      expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);

      await restoreInserts('channel_messages');
      const redriven = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      expect(redriven.status).toBe('refused');
      expect(sendSms).toHaveBeenCalledTimes(1);
    });

    describe('a failed send on the add-command door', () => {
      class RefusingTransport extends FakeTransport {
        constructor(private readonly refusal: () => Error) {
          super();
        }
        override async send(input: Parameters<FakeTransport['send']>[0]) {
          if (input.to === COPARENT_PHONE) throw this.refusal();
          return super.send(input);
        }
      }

      async function parentSaysYes(transport: FakeTransport) {
        const seeded = await seedHousehold();
        const started = await startCoParentInvite(db.database, {
          familyId: seeded.familyId,
          invitedByUserId: seeded.parentUserId,
          inviterPhoneE164: PARENT_PHONE,
          inviterName: 'Jimmy',
          parsed: { ok: true, role: 'co_parent', name: 'Sam', phoneE164: COPARENT_PHONE },
          language: 'en',
          now: NOW,
          ask: askWriter(),
        });
        expect(started.status).toBe('started');
        const yesFrom = (from: FakeTransport, providerId: string) =>
          handleKnownNumberInbound(
            db.database,
            {
              owner: { userId: seeded.parentUserId, familyId: seeded.familyId },
              phoneE164: PARENT_PHONE,
              inbound: from.inbound(PARENT_PHONE, 'yes', { providerId, receivedAt: NOW }),
              now: NOW,
            },
            {
              transport: from,
              threadMessage: async () => 'conv-1',
              openQuestions: fakeNoOpenQuestions,
              consent: yesNoReader(),
              ask: askWriter(),
            },
          );
        return { seeded, turn: yesFrom(transport, 'in-parent-yes'), yesFrom };
      }

      it.each([
        ['a timeout', () => new LinqSendError('timeout', 0, false)],
        ['a 503', () => new LinqSendError('http_503', 503, false)],
        ['a 409', () => new LinqSendError('http_409', 409, true)],
        ['a certain refusal', () => new LinqSendError('1002', 400, true)],
      ])(
        'policy on: after %s the number’s yes seats nobody and the redelivered yes sends under the same key',
        async (_name, err) => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const failing = new RefusingTransport(err);
          const { seeded, turn, yesFrom } = await parentSaysYes(failing);
          await expect(turn).rejects.toThrow('linq send failed');
          expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
          expect(await grantRows(seeded.familyId)).toBe(1);
          expect(failing.sent.filter((sent) => sent.to === PARENT_PHONE)).toEqual([]);

          const stranger = await answerFrom(NEVER_INVITED_PHONE, 'yes', 'in-add-stranger');
          const waiting = await answerFrom(COPARENT_PHONE, 'yes', 'in-add-waiting-yes');
          expect(waiting.outcome.status).toBe(stranger.outcome.status);
          expect(waiting.bodies).toEqual(stranger.bodies);
          expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
          expect(await memberRoles(seeded.familyId)).toEqual(['primary_parent']);
          expect(await inviteReplyConsents()).toBe(0);

          const accepting = new FakeTransport();
          const redelivered = await yesFrom(accepting, 'in-parent-yes');

          expect(redelivered?.status).toBe('co_parent_invite_sent');
          const [row] = await db.database
            .select({ id: schema.caregiverInvites.id })
            .from(schema.caregiverInvites);
          const toThem = accepting.sent.filter((sent) => sent.to === COPARENT_PHONE);
          expect(toThem).toHaveLength(1);
          expect(toThem[0]?.sendKey).toBe(`co_parent_invite:${row?.id}`);
          expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
          expect(await grantRows(seeded.familyId)).toBe(1);
          const inbound = await db.database
            .select({ id: schema.channelMessages.id })
            .from(schema.channelMessages)
            .where(eq(schema.channelMessages.providerMessageId, 'in-parent-yes'));
          expect(inbound).toHaveLength(1);
        },
      );

      it('policy on: a ledger write that fails after Linq took the text does not hold it', async () => {
        vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
        await failInserts(
          'channel_messages',
          `new.direction = 'out' and new.category = 'co_parent_invite'`,
        );
        const transport = new FakeTransport();
        const { turn } = await parentSaysYes(transport);
        await expect(turn).rejects.toThrow();
        expect(transport.sent.filter((sent) => sent.to === COPARENT_PHONE)).toHaveLength(1);
        expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
      });

      describe('a redelivered yes and a newer invite', () => {
        const ADD_SAM = 'add Sam 905-555-0182 as my partner';
        const ADD_ROBIN = 'add Robin 416-555-0133 as my partner';
        const timeout = () => new LinqSendError('timeout', 0, false);

        async function stateOf(phone: string): Promise<string[]> {
          const rows = await db.database
            .select({ state: schema.caregiverInvites.state })
            .from(schema.caregiverInvites)
            .where(eq(schema.caregiverInvites.phoneE164Hash, phoneBlindIndex(phone)));
          return rows.map((row) => row.state);
        }

        const fromParent = (body: string, providerId: string, transport: FakeTransport) =>
          answerFrom(PARENT_PHONE, body, providerId, 'none', transport);

        async function samsYesFailed(): Promise<{ familyId: string; parentUserId: string }> {
          const seeded = await seedHousehold();
          const failing = new RefusingTransport(timeout);
          const add = await fromParent(ADD_SAM, 'in-add-sam', failing);
          expect(add.outcome.status).toBe('co_parent_invite_started');
          await expect(fromParent('yes', 'in-parent-yes', failing)).rejects.toThrow(
            'linq send failed',
          );
          expect(await stateOf(COPARENT_PHONE)).toEqual(['awaiting_parent_assent']);
          return seeded;
        }

        it('policy on: the old yes does not text the person the parent named next', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const seeded = await samsYesFailed();
          const added = await fromParent(ADD_ROBIN, 'in-add-robin', new FakeTransport());
          expect(added.outcome.status).toBe('co_parent_invite_started');

          const redelivery = new FakeTransport();
          const { outcome } = await fromParent('yes', 'in-parent-yes', redelivery);

          expect(outcome.status).toBe('co_parent_assent_already_claimed');
          expect(redelivery.sent).toEqual([]);
          expect(await stateOf(NEVER_INVITED_PHONE)).toEqual(['awaiting_parent_assent']);
          expect(await grantRows(seeded.familyId)).toBe(1);
        });

        it('policy on: the old yes does not re-send a newer invite the parent also approved', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const seeded = await samsYesFailed();
          class RefusesRobin extends FakeTransport {
            override async send(input: Parameters<FakeTransport['send']>[0]) {
              if (input.to === NEVER_INVITED_PHONE) throw timeout();
              return super.send(input);
            }
          }
          const refusing = new RefusesRobin();
          await fromParent(ADD_ROBIN, 'in-add-robin', refusing);
          await expect(fromParent('yes', 'in-parent-yes-2', refusing)).rejects.toThrow(
            'linq send failed',
          );
          expect(await grantRows(seeded.familyId)).toBe(2);

          const redelivery = new FakeTransport();
          const { outcome } = await fromParent('yes', 'in-parent-yes', redelivery);

          expect(outcome.status).toBe('co_parent_assent_already_claimed');
          expect(redelivery.sent).toEqual([]);
          expect(await stateOf(NEVER_INVITED_PHONE)).toEqual(['awaiting_parent_assent']);
          expect(await grantRows(seeded.familyId)).toBe(2);
        });

        it('positive control, policy on: the same invite’s redelivered yes sends under its key', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const seeded = await samsYesFailed();

          const redelivery = new FakeTransport();
          const { outcome } = await fromParent('yes', 'in-parent-yes', redelivery);

          expect(outcome.status).toBe('co_parent_invite_sent');
          const [row] = await db.database
            .select({ id: schema.caregiverInvites.id })
            .from(schema.caregiverInvites);
          const toSam = redelivery.sent.filter((sent) => sent.to === COPARENT_PHONE);
          expect(toSam.map((sent) => sent.sendKey)).toEqual([`co_parent_invite:${row?.id}`]);
          expect(await stateOf(COPARENT_PHONE)).toEqual(['awaiting_caregiver_reply']);
          expect(await grantRows(seeded.familyId)).toBe(1);
        });

        it('policy on: a yes whose grant was never written is not re-run, and a new yes sends', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const seeded = await seedHousehold();
          await fromParent(ADD_SAM, 'in-add-sam', new FakeTransport());
          await failInserts('consent_records');
          await expect(fromParent('yes', 'in-parent-yes', new FakeTransport())).rejects.toThrow();
          await restoreInserts('consent_records');
          expect(await stateOf(COPARENT_PHONE)).toEqual(['awaiting_parent_assent']);

          const redelivery = new FakeTransport();
          const redelivered = await fromParent('yes', 'in-parent-yes', redelivery);
          expect(redelivered.outcome.status).toBe('co_parent_assent_already_claimed');
          expect(redelivery.sent).toEqual([]);
          expect(await grantRows(seeded.familyId)).toBe(0);

          const again = new FakeTransport();
          const answered = await fromParent('yes', 'in-parent-yes-again', again);
          expect(answered.outcome.status).toBe('co_parent_invite_sent');
          expect(again.sent.filter((sent) => sent.to === COPARENT_PHONE)).toHaveLength(1);
          expect(await grantRows(seeded.familyId)).toBe(1);
        });

        it('policy off: the old yes throws on the inbound row and texts no one, as on main', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
          const seeded = await seedHousehold();
          const failing = new RefusingTransport(timeout);
          await fromParent(ADD_SAM, 'in-add-sam', failing);
          await expect(fromParent('yes', 'in-parent-yes', failing)).rejects.toThrow(
            'linq send failed',
          );
          await fromParent(ADD_ROBIN, 'in-add-robin', new FakeTransport());

          const redelivery = new FakeTransport();
          await expect(fromParent('yes', 'in-parent-yes', redelivery)).rejects.toThrow();

          expect(redelivery.sent).toEqual([]);
          expect(await stateOf(NEVER_INVITED_PHONE)).toEqual(['awaiting_parent_assent']);
          expect(await grantRows(seeded.familyId)).toBe(1);
        });

        it('policy on: a second ask opened during the send stays the only one waiting', async () => {
          vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
          const seeded = await seedHousehold();
          class AddsRobinMidSend extends FakeTransport {
            override async send(input: Parameters<FakeTransport['send']>[0]) {
              if (input.to !== COPARENT_PHONE) return super.send(input);
              const added = await fromParent(
                'add Robin 416-555-0133 as grandparent',
                'in-add-robin',
                new FakeTransport(),
              );
              expect(added.outcome.status).toBe('caregiver_invite_started');
              throw timeout();
            }
          }
          const transport = new AddsRobinMidSend();
          await fromParent(ADD_SAM, 'in-add-sam', transport);
          await expect(fromParent('yes', 'in-parent-yes', transport)).rejects.toThrow(
            'linq send failed',
          );

          expect(await stateOf(COPARENT_PHONE)).toEqual(['expired_unsent']);
          expect(await stateOf(NEVER_INVITED_PHONE)).toEqual(['awaiting_parent_assent']);
          const pending = await loadPendingAssent(db.database, seeded.parentUserId, NOW);
          expect(pending?.phoneE164).toBe(NEVER_INVITED_PHONE);
          expect(await declineOpenInviteOnStop(db.database, COPARENT_PHONE, NOW)).toBe(true);
          expect(await stateOf(COPARENT_PHONE)).toEqual(['declined']);
        });
      });

      it('policy off: a failed send leaves the row where main leaves it', async () => {
        vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
        const { turn } = await parentSaysYes(
          new RefusingTransport(() => new LinqSendError('timeout', 0, false)),
        );
        await expect(turn).rejects.toThrow('linq send failed');
        expect(await inviteStates()).toEqual(['awaiting_caregiver_reply']);
      });
    });

    it('policy on: a turn that loses the claim sends nothing and says nothing', async () => {
      vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
      const { seeded, turn } = await seedTurn();
      const sendSms = vi.fn(async () => ({ providerMessageId: 'SM_never' }));
      await db.exec(`
        create or replace function lose_invite_claim_for_test() returns trigger as $$
        begin
          return null;
        end;
        $$ language plpgsql;
        create trigger ${CLAIM_LOST_TRIGGER} before update on caregiver_invites
          for each row when (new.state = 'awaiting_caregiver_reply')
          execute function lose_invite_claim_for_test();
      `);
      const outcome = await deliverCoParentNumberInvite(db.database, { ...turn, sendSms });
      expect(outcome).toEqual({ status: 'already_claimed', reply: null });
      expect(sendSms).not.toHaveBeenCalled();
      expect(await grantRows(seeded.familyId)).toBe(0);
      expect(await inviteLedgerRows()).toBe(0);
    });
  });

  it('redirects and does not text when the SMS flag is dark', async () => {
    vi.stubEnv('F14_ENABLED', '');
    const seeded = await seedHousehold();
    const inboundId = await seedAsk(seeded, 'sms');
    const sendSms = vi.fn();
    const outcome = await deliverCoParentNumberInvite(db.database, {
      ...seeded,
      body: '9055550182',
      now: NOW,
      inboundChannelMessageId: inboundId,
      sendSms,
    });
    expect(outcome).toMatchObject({ status: 'refused', reply: CO_PARENT_REDIRECT });
    expect(sendSms).not.toHaveBeenCalled();
    expect(await inviteStates()).toEqual([]);
  });
});
