import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  INTAKE_CONTENT_REDACTED,
  type MessageRetentionSummary,
  sweepMessageRetention,
} from './message-retention';

/**
 * Twelve-month message retention against the real DDL. A message older than
 * 365 days loses its content, one at 364 days keeps it, a group sender who
 * never became a user is covered, and a run stops at the batch cap.
 */

const NOW = new Date('2026-10-07T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

const ZEROS: MessageRetentionSummary = {
  channelMessagesRedacted: 0,
  messagesDeleted: 0,
  chatAttachmentsDeleted: 0,
  intakeSessionsRedacted: 0,
  emailForwardsDeleted: 0,
  forwardAsksRedacted: 0,
  consentEvidenceRedacted: 0,
  checkInNotesDeleted: 0,
  eventPayloadsRedacted: 0,
  actionPayloadsRedacted: 0,
};

let db: TestDb;
let households = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table sms_intake_sessions, families, users cascade');
});

async function seedFamily() {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: `Household ${households}`, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [parent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `google_retention_${households}` })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = parent?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  return { familyId, parentUserId };
}

async function channelMessage(input: {
  familyId: string;
  parentUserId: string;
  body: string | null;
  createdAt: Date;
}) {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: input.body,
      createdAt: input.createdAt,
    })
    .returning({ id: schema.channelMessages.id });
  return row?.id as string;
}

describe('sweepMessageRetention', () => {
  it('removes message content older than 365 days and keeps a message at 364 days', async () => {
    const { familyId, parentUserId } = await seedFamily();
    const removeObject = vi.fn(async (_path: string) => {});

    const oldChannelId = await channelMessage({
      familyId,
      parentUserId,
      body: 'the old inbound text',
      createdAt: ago(366),
    });
    const youngChannelId = await channelMessage({
      familyId,
      parentUserId,
      body: 'the recent inbound text',
      createdAt: ago(364),
    });
    await db.database.insert(schema.activityBookings).values({
      familyId,
      parentUserId,
      integrationId: '11111111-1111-4111-8111-111111111111',
      messageId: 'provider-msg-old',
      providerHost: 'recreation.example.ca',
      title: 'Swim',
      firstSessionAt: ago(300),
      channelMessageId: oldChannelId,
    });

    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId })
      .returning({ id: schema.conversations.id });
    const conversationId = conversation?.id as string;
    const [oldTurn] = await db.database
      .insert(schema.messages)
      .values({
        conversationId,
        role: 'user',
        content: 'delete this transcript',
        createdAt: ago(366),
      })
      .returning({ id: schema.messages.id });
    await db.database.insert(schema.messages).values({
      conversationId,
      role: 'user',
      content: 'keep this transcript',
      createdAt: ago(364),
    });
    const oldAttachmentPath = `chat/${familyId}/old-file`;
    await db.database.insert(schema.chatAttachments).values({
      familyId,
      conversationId,
      messageId: oldTurn?.id as string,
      storagePath: oldAttachmentPath,
      mime: 'image/jpeg',
      sizeBytes: 12,
      originalName: 'rash.jpg',
      createdAt: ago(366),
    });
    const youngAttachmentPath = `chat/${familyId}/young-file`;
    await db.database.insert(schema.chatAttachments).values({
      familyId,
      storagePath: youngAttachmentPath,
      mime: 'application/pdf',
      sizeBytes: 8,
      originalName: 'keep.pdf',
      createdAt: ago(364),
    });
    const unlinkedOldPath = `chat/${familyId}/unlinked-old`;
    await db.database.insert(schema.chatAttachments).values({
      familyId,
      storagePath: unlinkedOldPath,
      mime: 'image/png',
      sizeBytes: 4,
      originalName: 'stranger.png',
      createdAt: ago(400),
    });

    await db.database.insert(schema.events).values([
      {
        familyId,
        source: 'gmail',
        eventType: 'message.received',
        payload: { body: 'old email body', from: 'school@example.com', kind: 'email' },
        dedupHash: 'old-event',
        receivedAt: ago(366),
      },
      {
        familyId,
        source: 'gmail',
        eventType: 'message.received',
        payload: { body: 'recent email body', kind: 'email' },
        dedupHash: 'young-event',
        receivedAt: ago(364),
      },
    ]);
    const [oldEvent] = await db.database
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.dedupHash, 'old-event'));
    const [youngEvent] = await db.database
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(eq(schema.events.dedupHash, 'young-event'));
    await db.database.insert(schema.actions).values([
      {
        eventId: oldEvent?.id as string,
        familyId,
        actionType: 'send_email',
        payload: { body: 'drafted old reply', slot: 'tuesday' },
        executorResult: { to: 'school@example.com', status: 'sent' },
        draftedAt: ago(366),
      },
      {
        eventId: youngEvent?.id as string,
        familyId,
        actionType: 'send_email',
        payload: { body: 'drafted recent reply', slot: 'wednesday' },
        draftedAt: ago(364),
      },
    ]);

    await db.database.insert(schema.familyForwardSenders).values([
      {
        familyId,
        senderDomain: 'old.example.com',
        ref: 'aaaa1111',
        askBody: 'May Hale read mail from old.example.com?',
        state: 'pending',
        createdAt: ago(366),
      },
      {
        familyId,
        senderDomain: 'young.example.com',
        ref: 'bbbb2222',
        askBody: 'May Hale read mail from young.example.com?',
        state: 'pending',
        createdAt: ago(364),
      },
    ]);
    const senders = await db.database
      .select({
        id: schema.familyForwardSenders.id,
        domain: schema.familyForwardSenders.senderDomain,
      })
      .from(schema.familyForwardSenders);
    const oldSender = senders.find((row) => row.domain === 'old.example.com');
    const youngSender = senders.find((row) => row.domain === 'young.example.com');
    await db.database.insert(schema.emailForwardsPending).values([
      {
        familyId,
        senderId: oldSender?.id as string,
        providerMessageId: 'old-forward',
        originalFrom: 'office@old.example.com',
        subject: 'picture day',
        rawBody: 'bring a smile',
        receivedAt: ago(366),
        createdAt: ago(366),
      },
      {
        familyId,
        senderId: youngSender?.id as string,
        providerMessageId: 'young-forward',
        originalFrom: 'office@young.example.com',
        subject: 'next week',
        rawBody: 'still relevant',
        receivedAt: ago(364),
        createdAt: ago(364),
      },
    ]);

    await db.database.insert(schema.consentRecords).values([
      {
        userId: parentUserId,
        familyId,
        consentType: 'sms_service_messages',
        granted: true,
        policyVersion: '2026-01',
        grantedAt: ago(366),
        evidence: {
          verbatimReply: "I'm his grandma",
          interpretation: 'caregiver',
          channel: 'imessage',
        },
      },
      {
        userId: parentUserId,
        familyId,
        consentType: 'proactive_watch',
        granted: true,
        policyVersion: '2026-01',
        grantedAt: ago(364),
        evidence: {
          verbatimReply: 'yes keep watching',
          interpretation: 'granted',
          channel: 'sms',
        },
      },
    ]);

    const oldNoteSource = await channelMessage({
      familyId,
      parentUserId,
      body: 'note source old',
      createdAt: ago(366),
    });
    const youngNoteSource = await channelMessage({
      familyId,
      parentUserId,
      body: 'note source recent',
      createdAt: ago(364),
    });
    await db.database.insert(schema.familyCheckInNotes).values([
      {
        familyId,
        parentUserId,
        sourceMessageId: oldNoteSource,
        notedOn: '2025-01-01',
        note: 'she hated the dentist',
        expiresAt: ago(300),
        createdAt: ago(366),
      },
      {
        familyId,
        parentUserId,
        sourceMessageId: youngNoteSource,
        notedOn: '2026-09-01',
        note: 'good day at the park',
        expiresAt: new Date(NOW.getTime() + DAY_MS),
        createdAt: ago(364),
      },
    ]);

    const first = await sweepMessageRetention(db.database, NOW, { removeObject });

    expect(first).toEqual({
      ...ZEROS,
      channelMessagesRedacted: 2,
      messagesDeleted: 1,
      chatAttachmentsDeleted: 2,
      emailForwardsDeleted: 1,
      forwardAsksRedacted: 1,
      consentEvidenceRedacted: 1,
      checkInNotesDeleted: 1,
      eventPayloadsRedacted: 1,
      actionPayloadsRedacted: 1,
    });

    const channels = await db.database
      .select({ id: schema.channelMessages.id, body: schema.channelMessages.body })
      .from(schema.channelMessages);
    expect(channels.find((row) => row.id === oldChannelId)?.body).toBeNull();
    expect(channels.find((row) => row.id === youngChannelId)?.body).toBe('the recent inbound text');
    expect(channels.find((row) => row.id === youngNoteSource)?.body).toBe('note source recent');

    const bookings = await db.database
      .select({ channelMessageId: schema.activityBookings.channelMessageId })
      .from(schema.activityBookings);
    expect(bookings).toEqual([{ channelMessageId: oldChannelId }]);

    const turns = await db.database
      .select({ content: schema.messages.content })
      .from(schema.messages);
    expect(turns).toEqual([{ content: 'keep this transcript' }]);

    const files = await db.database
      .select({
        storagePath: schema.chatAttachments.storagePath,
        originalName: schema.chatAttachments.originalName,
      })
      .from(schema.chatAttachments);
    expect(files).toEqual([{ storagePath: youngAttachmentPath, originalName: 'keep.pdf' }]);
    expect(removeObject.mock.calls.map((call) => call[0]).sort()).toEqual(
      [oldAttachmentPath, unlinkedOldPath].sort(),
    );

    const events = await db.database
      .select({ payload: schema.events.payload, dedupHash: schema.events.dedupHash })
      .from(schema.events);
    expect(events.find((row) => row.dedupHash === 'old-event')?.payload).toEqual({ kind: 'email' });
    expect(events.find((row) => row.dedupHash === 'young-event')?.payload).toEqual({
      body: 'recent email body',
      kind: 'email',
    });

    const actions = await db.database
      .select({
        payload: schema.actions.payload,
        executorResult: schema.actions.executorResult,
        draftedAt: schema.actions.draftedAt,
      })
      .from(schema.actions);
    const oldAction = actions.find((row) => row.draftedAt.getTime() === ago(366).getTime());
    const youngAction = actions.find((row) => row.draftedAt.getTime() === ago(364).getTime());
    expect(oldAction?.payload).toEqual({ slot: 'tuesday' });
    expect(oldAction?.executorResult).toEqual({ status: 'sent' });
    expect(youngAction?.payload).toEqual({
      body: 'drafted recent reply',
      slot: 'wednesday',
    });

    const asks = await db.database
      .select({
        domain: schema.familyForwardSenders.senderDomain,
        askBody: schema.familyForwardSenders.askBody,
        state: schema.familyForwardSenders.state,
      })
      .from(schema.familyForwardSenders);
    expect(asks.find((row) => row.domain === 'old.example.com')).toMatchObject({
      askBody: null,
      state: 'pending',
    });
    expect(asks.find((row) => row.domain === 'young.example.com')?.askBody).toBe(
      'May Hale read mail from young.example.com?',
    );

    const forwards = await db.database
      .select({
        rawBody: schema.emailForwardsPending.rawBody,
        originalFrom: schema.emailForwardsPending.originalFrom,
      })
      .from(schema.emailForwardsPending);
    expect(forwards).toEqual([
      { rawBody: 'still relevant', originalFrom: 'office@young.example.com' },
    ]);

    const consents = await db.database
      .select({
        consentType: schema.consentRecords.consentType,
        granted: schema.consentRecords.granted,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords);
    expect(consents.find((row) => row.consentType === 'sms_service_messages')).toEqual({
      consentType: 'sms_service_messages',
      granted: true,
      evidence: { interpretation: 'caregiver', channel: 'imessage' },
    });
    expect(consents.find((row) => row.consentType === 'proactive_watch')?.evidence).toEqual({
      verbatimReply: 'yes keep watching',
      interpretation: 'granted',
      channel: 'sms',
    });

    const notes = await db.database
      .select({ note: schema.familyCheckInNotes.note })
      .from(schema.familyCheckInNotes);
    expect(notes).toEqual([{ note: 'good day at the park' }]);

    const second = await sweepMessageRetention(db.database, NOW, { removeObject });
    expect(second).toEqual(ZEROS);
    expect(removeObject).toHaveBeenCalledTimes(2);
  });

  it('covers a group-chat message from someone who is not a Hale user', async () => {
    const oldSecret = 'grandma in the group: swim at four, not a hale user';
    const oldPhone = '+14165550199';
    await db.database.insert(schema.smsIntakeSessions).values({
      phoneHash: 'blind-old-stranger',
      phoneEncrypted: oldPhone,
      state: 'awaiting_details',
      dataEncrypted: oldSecret,
      updatedAt: ago(400),
      createdAt: ago(400),
    });
    const youngSecret = 'a stranger who texted last week';
    const youngPhone = '+14165550100';
    await db.database.insert(schema.smsIntakeSessions).values({
      phoneHash: 'blind-young-stranger',
      phoneEncrypted: youngPhone,
      state: 'awaiting_details',
      dataEncrypted: youngSecret,
      updatedAt: ago(364),
      createdAt: ago(364),
    });

    const summary = await sweepMessageRetention(db.database, NOW);

    expect(summary.intakeSessionsRedacted).toBe(1);
    const sessions = await db.database
      .select({
        phoneHash: schema.smsIntakeSessions.phoneHash,
        phoneEncrypted: schema.smsIntakeSessions.phoneEncrypted,
        dataEncrypted: schema.smsIntakeSessions.dataEncrypted,
        closedAt: schema.smsIntakeSessions.closedAt,
        userId: schema.smsIntakeSessions.userId,
      })
      .from(schema.smsIntakeSessions);
    const oldSession = sessions.find((row) => row.phoneHash === 'blind-old-stranger');
    const youngSession = sessions.find((row) => row.phoneHash === 'blind-young-stranger');
    expect(oldSession).toMatchObject({
      phoneHash: 'blind-old-stranger',
      phoneEncrypted: INTAKE_CONTENT_REDACTED,
      dataEncrypted: INTAKE_CONTENT_REDACTED,
      userId: null,
    });
    expect(oldSession?.closedAt).not.toBeNull();
    expect(oldSession?.dataEncrypted).not.toContain('grandma');
    expect(oldSession?.phoneEncrypted).not.toContain('416');
    expect(youngSession).toMatchObject({
      phoneEncrypted: youngPhone,
      dataEncrypted: youngSecret,
      closedAt: null,
      userId: null,
    });

    const again = await sweepMessageRetention(db.database, NOW);
    expect(again.intakeSessionsRedacted).toBe(0);
  });

  it('stops at the batch cap and leaves the rest for the next run', async () => {
    const { familyId, parentUserId } = await seedFamily();
    for (let i = 0; i < 5; i += 1) {
      await channelMessage({
        familyId,
        parentUserId,
        body: `old body ${i}`,
        createdAt: new Date(ago(400).getTime() + i * 1000),
      });
    }

    const first = await sweepMessageRetention(db.database, NOW, { batchSize: 2 });
    expect(first).toEqual({ ...ZEROS, channelMessagesRedacted: 2 });

    const remaining = await db.database
      .select({ body: schema.channelMessages.body })
      .from(schema.channelMessages);
    const stillThere = remaining.filter((row) => row.body !== null);
    expect(stillThere).toHaveLength(3);

    const second = await sweepMessageRetention(db.database, NOW, { batchSize: 2 });
    expect(second.channelMessagesRedacted).toBe(2);
    const afterSecond = await db.database
      .select({ body: schema.channelMessages.body })
      .from(schema.channelMessages);
    expect(afterSecond.filter((row) => row.body !== null)).toHaveLength(1);
  });
});
