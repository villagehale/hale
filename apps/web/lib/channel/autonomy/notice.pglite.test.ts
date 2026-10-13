import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { dispatchAutonomyNotices } from './dispatch';
import {
  type AutonomyNoticePorts,
  autonomyNoticeReaders,
  tellParentHaleActed,
  tellParentKindArmed,
} from './notice';
import type { AutonomyNoticeContext, AutonomyNoticeText } from './notice-text';

/**
 * The sender wires the model's text onto the phone. The composer is a port: these
 * tests prove a skip sends nothing, quiet hours does not claim the text, and the
 * body that leaves is the composer's text. Tone is the eval's judge, not a phrase
 * check here.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const MORNING = new Date('2026-09-16T14:12:00.000Z');
const NIGHT = new Date('2026-09-17T03:12:00.000Z');

let db: TestDb;
let households = 0;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedParent() {
  households += 1;
  const phone = `+1416555${7000 + households}`;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [parent] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:arm-${households}`,
      name: 'Ana',
      timezone: 'America/Toronto',
      locale: 'en',
    })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: MORNING,
  });
  await recordWatchConsent(
    db.database,
    {
      familyId,
      userId: parentUserId,
      granted: true,
      verbatimReply: 'yes',
      interpretation: 'the parent said yes to being watched',
      channelMessageId: null,
    },
    MORNING,
  );
  return { familyId, parentUserId, phone };
}

async function grant(familyId: string, parentUserId: string, actionType: string, grantedAt?: Date) {
  const [row] = await db.database
    .insert(schema.consentRecords)
    .values({
      familyId,
      userId: parentUserId,
      consentType: 'autonomous_action_class',
      consentScope: actionType,
      granted: true,
      policyVersion: 'test-policy',
      ...(grantedAt ? { grantedAt } : {}),
    })
    .returning({ id: schema.consentRecords.id });
  if (!row) throw new Error('grant insert returned no row');
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor: parentUserId,
    actionTaken: 'autonomous_action_class.granted',
    targetTable: 'consent_records',
    targetId: row.id,
    after: { consentType: 'autonomous_action_class', consentScope: actionType },
  });
  return row.id;
}

function ports(compose: (input: AutonomyNoticeContext) => Promise<AutonomyNoticeText>) {
  const seen: AutonomyNoticeContext[] = [];
  const transport = new FakeTransport();
  const threaded: string[] = [];
  const sendPorts: AutonomyNoticePorts = {
    ...autonomyNoticeReaders(db.database),
    compose: async (input) => {
      seen.push(input);
      return compose(input);
    },
    transport,
    threadMessage: async (_database, input) => {
      threaded.push(input.body);
      return 'conv-1';
    },
  };
  return { sendPorts, seen, transport, threaded };
}

describe('telling a parent a kind turned on', () => {
  it('sends the composer’s text and nothing else, once per grant', async () => {
    const parent = await seedParent();
    const consentRecordId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const text = `model arm ${households}`;
    const { sendPorts, transport, threaded, seen } = ports(async () => ({ message: text }));

    const outcome = await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId, actionType: 'send_email', now: MORNING },
      sendPorts,
    );

    expect(outcome).toBe('sent');
    expect(seen.map((row) => row.occasion)).toEqual(['armed']);
    expect(transport.bodies()).toEqual([text]);
    expect(threaded).toEqual([text]);

    const again = await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId, actionType: 'send_email', now: MORNING },
      sendPorts,
    );
    expect(again).toBe('already_sent');
    expect(transport.bodies()).toEqual([text]);
  });

  it('a later grant is a re-arm and gets its own text', async () => {
    const parent = await seedParent();
    const first = await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-09-01T12:00:00.000Z'),
    );
    await db.database.insert(schema.consentRecords).values({
      familyId: parent.familyId,
      userId: parent.parentUserId,
      consentType: 'autonomous_action_class',
      consentScope: 'send_email',
      granted: false,
      grantedAt: new Date('2026-09-02T12:00:00.000Z'),
      policyVersion: 'test-policy',
    });
    const second = await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-09-03T12:00:00.000Z'),
    );
    const { sendPorts, seen } = ports(async () => ({ message: `model rearm ${households}` }));

    await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId: first, actionType: 'send_email', now: MORNING },
      sendPorts,
    );
    await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId: second, actionType: 'send_email', now: MORNING },
      sendPorts,
    );
    expect(seen.map((row) => row.occasion)).toEqual(['armed', 'rearmed']);
  });

  it('quiet hours holds the text without claiming it, and does not call the model', async () => {
    const parent = await seedParent();
    const consentRecordId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const { sendPorts, seen } = ports(async () => ({ message: 'should not send' }));

    const outcome = await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId, actionType: 'send_email', now: NIGHT },
      sendPorts,
    );

    expect(outcome).toBe('gate_refused:quiet_hours');
    expect(seen).toEqual([]);
    const rows = await db.database
      .select({
        dedupeKey: schema.channelMessages.dedupeKey,
        status: schema.channelMessages.status,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, parent.familyId));
    expect(rows).toEqual([{ dedupeKey: null, status: 'suppressed_quiet_hours' }]);
  });

  it('a model skip sends nothing and leaves the obligation open', async () => {
    const parent = await seedParent();
    const consentRecordId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const { sendPorts, transport } = ports(async () => ({ skipped: 'model_failed' }));

    const outcome = await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId, actionType: 'send_email', now: MORNING },
      sendPorts,
    );

    expect(outcome).toBe('compose_skipped:model_failed');
    expect(transport.bodies()).toEqual([]);
    const claimed = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, parent.familyId),
          eq(schema.channelMessages.dedupeKey, `autonomy_armed:${consentRecordId}`),
        ),
      );
    expect(claimed).toEqual([]);
  });

  it('the on-its-own notice sends the composer’s text for that execution', async () => {
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'send_email');
    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: parent.familyId,
        source: 'test',
        eventType: 'signal.test',
        dedupHash: `acted-${households}`,
        status: 'actioned',
      })
      .returning({ id: schema.events.id });
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: event?.id as string,
        familyId: parent.familyId,
        actionType: 'send_email',
        payload: {},
      })
      .returning({ id: schema.actions.id });
    const actionId = action?.id as string;
    await db.database.insert(schema.auditLog).values({
      familyId: parent.familyId,
      actor: 'system',
      actionTaken: 'action.executed',
      targetTable: 'actions',
      targetId: actionId,
      after: { decision: { source: 'autonomous', reason: 'the kind was on' } },
    });
    const { sendPorts, transport, seen } = ports(async (input) => ({
      message: `model ${input.occasion} ${households}`,
    }));

    const outcome = await tellParentHaleActed(
      db.database,
      { ...parent, actionId, actionType: 'send_email', now: MORNING },
      sendPorts,
    );

    expect(outcome).toBe('sent');
    expect(seen.map((row) => row.occasion)).toEqual(['acted']);

    // The grant's turn-on text is still owed. One parent hears one notice per pass,
    // and a claimed execution is not selected again.
    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(dispatched.sent).toBe(1);
    expect(seen.map((row) => row.occasion)).toEqual(['acted', 'armed']);

    const again = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(again.open).toBe(0);
    expect(again.sent).toBe(0);
    expect(transport.bodies()).toEqual([`model acted ${households}`, `model armed ${households}`]);
  });

  it('sends nothing while the lane is unset, then sends when it is exactly true', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('F14_ENABLED', 'true');
    expect(process.env.AUTONOMOUS_EXECUTE_ENABLED).not.toBe('true');
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'send_email');
    const text = `model arm ${households}`;
    const { sendPorts, seen, transport } = ports(async () => ({ message: text }));

    const held = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(held.laneOff).toBe(1);
    expect(held.sent).toBe(0);
    expect(seen).toEqual([]);

    vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true ');
    const trimmed = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(trimmed.laneOff).toBe(1);
    expect(trimmed.sent).toBe(0);
    expect(seen).toEqual([]);

    const claimed = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, parent.familyId));
    expect(claimed).toEqual([]);

    vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
    const sent = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(sent.sent).toBe(1);
    expect(sent.laneOff).toBe(0);
    expect(transport.bodies()).toEqual([text]);
  });

  it('gives the model the parent’s own texts and the stored locale, and picks no language', async () => {
    const parent = await seedParent();
    await db.database
      .update(schema.users)
      .set({ locale: 'fr' })
      .where(eq(schema.users.id, parent.parentUserId));
    await db.database.insert(schema.channelMessages).values([
      {
        familyId: parent.familyId,
        parentUserId: parent.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'premier message',
        createdAt: new Date('2026-09-01T12:00:00.000Z'),
      },
      {
        familyId: parent.familyId,
        parentUserId: parent.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: '第二个',
        createdAt: new Date('2026-09-02T12:00:00.000Z'),
      },
    ]);
    const consentRecordId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const { sendPorts, seen } = ports(async () => ({ message: `model arm ${households}` }));

    await tellParentKindArmed(
      db.database,
      { ...parent, consentRecordId, actionType: 'send_email', now: MORNING },
      sendPorts,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.localeHint).toBe('fr');
    expect(seen[0]?.recentInbound).toEqual(['premier message', '第二个']);
    expect(seen[0]).not.toHaveProperty('language');
  });

  it('still owes a turn-on text that is older than seven days', async () => {
    const parent = await seedParent();
    const consentRecordId = await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-08-01T12:00:00.000Z'),
    );
    const { sendPorts, seen } = ports(async () => ({ message: `model arm ${households}` }));

    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(dispatched.sent).toBe(1);
    expect(dispatched.agedOut).toBe(0);
    expect(seen.map((row) => row.occasion)).toEqual(['armed']);
    const claimed = await db.database
      .select({ dedupeKey: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, `autonomy_armed:${consentRecordId}`));
    expect(claimed).toHaveLength(1);
  });

  it('counts an on-its-own notice older than seven days and does not send it', async () => {
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'send_email');
    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: parent.familyId,
        source: 'test',
        eventType: 'signal.test',
        dedupHash: `aged-${households}`,
        status: 'actioned',
      })
      .returning({ id: schema.events.id });
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: event?.id as string,
        familyId: parent.familyId,
        actionType: 'send_email',
        payload: {},
      })
      .returning({ id: schema.actions.id });
    await db.database.insert(schema.auditLog).values({
      familyId: parent.familyId,
      actor: 'system',
      actionTaken: 'action.executed',
      targetTable: 'actions',
      targetId: action?.id as string,
      occurredAt: new Date(MORNING.getTime() - 8 * 24 * 60 * 60 * 1000),
      after: { decision: { source: 'autonomous', reason: 'the kind was on' } },
    });
    const { sendPorts, seen } = ports(async () => ({ message: `model acted ${households}` }));

    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(dispatched.agedOut).toBe(1);
    expect(seen.map((row) => row.occasion)).toEqual(['armed']);
    expect(dispatched.sent).toBe(1);
  });
});
