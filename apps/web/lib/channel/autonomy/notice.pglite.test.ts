import { schema } from '@hale/db';
import { POSTHOG_ID_SALT_ENV, hashFamilyIdForFlags, setFlagEvaluatorForTests } from '@hale/flags';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { recordWatchConsent } from '~/lib/channel/intake/watch-consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { OpsPage } from '~/lib/monitoring/failure-page';
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
let actedNotices = 0;

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
  // VIL-719: most cases here grant send_email, an ask-first kind under the ask policy, so
  // the suite pins the policy off; the cases at the end turn it on.
  vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
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

async function seedCoParent(familyId: string, name: string) {
  households += 1;
  const phone = `+1416555${7000 + households}`;
  const [parent] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `sms:arm-${households}`,
      name,
      timezone: 'America/Toronto',
      locale: 'en',
    })
    .returning({ id: schema.users.id });
  const parentUserId = parent?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'co_parent',
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
  return { parentUserId, phone };
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

async function switchOff(familyId: string, parentUserId: string, grantedAt: Date) {
  await db.database.insert(schema.consentRecords).values({
    familyId,
    userId: parentUserId,
    consentType: 'autonomous_action_class',
    consentScope: 'send_email',
    granted: false,
    grantedAt,
    policyVersion: 'test-policy',
  });
}

async function channelRows(familyId: string) {
  return db.database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

async function messageRows(familyId: string) {
  return db.database
    .select({
      parentUserId: schema.channelMessages.parentUserId,
      dedupeKey: schema.channelMessages.dedupeKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
}

async function auditDedupeKeys(familyId: string, actionTaken: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, actionTaken)),
    );
  return rows
    .flatMap((row) => {
      const key = (row.after as { dedupeKey?: unknown } | null)?.dedupeKey;
      return typeof key === 'string' ? [key] : [];
    })
    .sort();
}

function ports(
  compose: (input: AutonomyNoticeContext) => Promise<AutonomyNoticeText>,
  transport = new FakeTransport(),
) {
  const seen: AutonomyNoticeContext[] = [];
  const threaded: string[] = [];
  const pages: OpsPage[] = [];
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
    pager: {
      page: async (page) => {
        pages.push(page);
        return 'paged';
      },
    },
  };
  return { sendPorts, seen, transport, threaded, pages };
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
        payload: { to: 'school@example.com', subject: 'pickup' },
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
    expect(seen[0]?.detail).toEqual({ to: 'school@example.com', subject: 'pickup' });
    expect(seen[0]?.why).toBe('the kind was on');
    expect(seen[0]?.items).toBeUndefined();
    expect(seen[0]?.standing).toEqual({
      may: null,
      never: null,
      stop: 'one_message',
    });

    // The grant's turn-on text is still owed. A claimed execution is not selected again.
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

  it('gives the model the parent’s own texts and their proactive language, and picks no language', async () => {
    const parent = await seedParent();
    await db.database
      .update(schema.users)
      .set({ locale: 'zh', proactiveLanguage: 'fr' })
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
    expect(seen[0]?.standing.may).toEqual({
      sendEmail: true,
      replyToEmail: false,
      addToCalendar: false,
      updateCalendar: false,
      moveCalendar: false,
      cancelCalendar: false,
      sharePhotos: false,
      addToDigest: false,
      addToRoutine: false,
    });
    expect(seen[0]?.standing.never).toEqual(['book', 'register', 'pay']);
    expect(seen[0]?.standing.stop).toBe('one_message');
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

    const again = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(again.agedOut).toBe(0);
    expect(again.sent).toBe(0);
    const marks = await db.database
      .select({ targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'autonomy_acted_notice_aged_out'));
    expect(marks).toHaveLength(1);
  });

  it('a switch-off cancels owed texts', async () => {
    const parent = await seedParent();
    const other = await seedCoParent(parent.familyId, 'Sam');
    await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-09-01T12:00:00.000Z'),
    );
    await grant(
      parent.familyId,
      other.parentUserId,
      'send_email',
      new Date('2026-09-02T12:00:00.000Z'),
    );
    await switchOff(parent.familyId, other.parentUserId, new Date('2026-09-03T12:00:00.000Z'));
    const { sendPorts } = ports(async () => ({ message: `model arm ${households}` }));

    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(dispatched.sent).toBe(0);
    const rows = await channelRows(parent.familyId);
    expect(rows).toEqual([]);
  });

  it('a fresh grant after a switch-off is owed', async () => {
    const parent = await seedParent();
    const other = await seedCoParent(parent.familyId, 'Sam');
    await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-09-01T12:00:00.000Z'),
    );
    await grant(
      parent.familyId,
      other.parentUserId,
      'send_email',
      new Date('2026-09-02T12:00:00.000Z'),
    );
    await switchOff(parent.familyId, other.parentUserId, new Date('2026-09-03T12:00:00.000Z'));
    const fresh = await grant(
      parent.familyId,
      parent.parentUserId,
      'send_email',
      new Date('2026-09-04T12:00:00.000Z'),
    );
    const { sendPorts } = ports(async () => ({ message: `model arm ${households}` }));

    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(dispatched.sent).toBe(1);
    expect(await channelRows(parent.familyId)).toEqual([
      { parentUserId: parent.parentUserId, dedupeKey: `autonomy_armed:${fresh}` },
    ]);
  });

  it('sends the on-its-own notice to every live parent', async () => {
    const parent = await seedParent();
    const other = await seedCoParent(parent.familyId, 'Sam');
    const parentGrant = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const otherGrant = await grant(parent.familyId, other.parentUserId, 'send_email');
    const actionId = await recordActed(parent.familyId, 'send_email', {
      payload: { to: 'school@example.com', subject: 'pickup' },
    });
    const { sendPorts, seen } = ports(async () => ({ message: `model acted ${households}` }));

    const dispatched = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(dispatched.sent).toBe(2);
    expect(dispatched.agedOut).toBe(0);
    expect(seen).toHaveLength(2);
    for (const row of seen) {
      expect(row.occasion).toBe('armed');
      expect(row.items?.map((item) => item.occasion)).toEqual(['armed', 'acted']);
      const acted = row.items?.find((item) => item.occasion === 'acted');
      expect(acted?.detail).toEqual({ to: 'school@example.com', subject: 'pickup' });
      expect(acted?.why).toBe('the kind was on');
    }

    const later = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    const rows = await messageRows(parent.familyId);
    expect(rows.filter((row) => row.errorCode === 'covered_by_combined_notice')).toEqual([]);
    expect(rows.filter((row) => row.status === 'queued')).toHaveLength(2);
    expect(rows.map((row) => row.dedupeKey).sort()).toEqual(
      [`autonomy_armed:${parentGrant}`, `autonomy_armed:${otherGrant}`].sort(),
    );
    expect(await auditDedupeKeys(parent.familyId, 'autonomy_acted_notice_sent')).toEqual(
      [
        `autonomy_acted:${actionId}:${parent.parentUserId}`,
        `autonomy_acted:${actionId}:${other.parentUserId}`,
      ].sort(),
    );
    expect(later.sent).toBe(0);
    expect(later.open).toBe(0);
    expect(later.agedOut).toBe(0);
  });

  it('one text covers two on-its-own notices and claims both keys', async () => {
    const parent = await seedParent();
    const grantId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const first = await recordActed(parent.familyId, 'send_email');
    const second = await recordActed(parent.familyId, 'send_email');
    const { sendPorts, transport } = ports(async () => ({ message: `model acted ${households}` }));

    const firstPass = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(firstPass.sent).toBe(1);
    expect(firstPass.agedOut).toBe(0);
    expect(transport.bodies()).toEqual([`model acted ${households}`]);
    const rows = await messageRows(parent.familyId);
    expect(rows.filter((row) => row.errorCode === 'covered_by_combined_notice')).toEqual([]);
    expect(rows).toEqual([
      {
        parentUserId: parent.parentUserId,
        dedupeKey: `autonomy_armed:${grantId}`,
        status: 'queued',
        errorCode: null,
      },
    ]);
    expect(await auditDedupeKeys(parent.familyId, 'autonomy_acted_notice_sent')).toEqual(
      [
        `autonomy_acted:${first}:${parent.parentUserId}`,
        `autonomy_acted:${second}:${parent.parentUserId}`,
      ].sort(),
    );

    const secondPass = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(secondPass.sent).toBe(0);
    expect(secondPass.open).toBe(0);
    expect(secondPass.agedOut).toBe(0);
    expect(transport.bodies()).toEqual([`model acted ${households}`]);
  });

  it('a refused send leaves no queued text and the covered keys can be tried again', async () => {
    const parent = await seedParent();
    const grantId = await grant(parent.familyId, parent.parentUserId, 'send_email');
    const actionId = await recordActed(parent.familyId, 'send_email');
    const transport = new FakeTransport();
    const realSend = transport.send.bind(transport);
    let refuse = true;
    transport.send = async (input) => {
      if (refuse) throw new Error('provider down');
      return realSend(input);
    };
    const { sendPorts } = ports(async () => ({ message: `model acted ${households}` }), transport);

    const failed = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(failed.sendFailed).toBe(1);
    expect(failed.sent).toBe(0);
    const held = await messageRows(parent.familyId);
    expect(held.filter((row) => row.status === 'queued')).toEqual([]);
    expect(held.filter((row) => row.errorCode === 'covered_by_combined_notice')).toEqual([]);
    expect(held.map((row) => row.dedupeKey)).toEqual([null]);
    expect(await auditDedupeKeys(parent.familyId, 'autonomy_notice_covered')).toEqual([
      `autonomy_acted:${actionId}:${parent.parentUserId}`,
    ]);
    expect(await auditDedupeKeys(parent.familyId, 'autonomy_notice_cover_released')).toEqual([
      `autonomy_acted:${actionId}:${parent.parentUserId}`,
    ]);

    refuse = false;
    const retried = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(retried.sent).toBe(1);
    const sent = (await messageRows(parent.familyId)).filter((row) => row.dedupeKey !== null);
    expect(sent).toEqual([
      {
        parentUserId: parent.parentUserId,
        dedupeKey: `autonomy_armed:${grantId}`,
        status: 'queued',
        errorCode: null,
      },
    ]);
    expect(await auditDedupeKeys(parent.familyId, 'autonomy_acted_notice_sent')).toEqual([
      `autonomy_acted:${actionId}:${parent.parentUserId}`,
    ]);
  });
});

async function recordActed(
  familyId: string,
  actionType: string,
  opts?: { payload?: Record<string, unknown>; askTier?: string },
) {
  actedNotices += 1;
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'test',
      eventType: 'signal.test',
      dedupHash: `acted-extra-${actedNotices}`,
      status: 'actioned',
    })
    .returning({ id: schema.events.id });
  const [action] = await db.database
    .insert(schema.actions)
    .values({
      eventId: event?.id as string,
      familyId,
      actionType,
      payload: opts?.payload ?? { to: 'school@example.com', subject: 'pickup' },
    })
    .returning({ id: schema.actions.id });
  const actionId = action?.id as string;
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'action.executed',
    targetTable: 'actions',
    targetId: actionId,
    after: {
      decision: {
        source: 'autonomous',
        reason: 'the kind was on',
        ...(opts?.askTier ? { askTier: opts.askTier } : {}),
      },
    },
  });
  return actionId;
}

describe('VIL-719 the ask policy on the on-its-own and turn-on texts', () => {
  afterEach(() => {
    setFlagEvaluatorForTests(null);
  });

  it('policy on: an on-its-own text the model could not write sends nothing, stays owed, and pages #ops', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const parent = await seedParent();
    const consentRecordId = await grant(
      parent.familyId,
      parent.parentUserId,
      'calendar_add',
      new Date(MORNING.getTime() - 60_000),
    );
    await db.database.insert(schema.auditLog).values({
      familyId: parent.familyId,
      actor: 'system',
      actionTaken: 'autonomy_armed_notice_sent',
      targetTable: 'consent_records',
      targetId: consentRecordId,
      after: { dedupeKey: `autonomy_armed:${consentRecordId}` },
    });
    const actionId = await recordActed(parent.familyId, 'calendar_add', {
      payload: { title: 'swim' },
      askTier: 'tell_after',
    });
    const { sendPorts, transport, pages } = ports(async () => ({ skipped: 'model_failed' }));

    const result = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(result.composeSkipped).toBe(1);
    expect(transport.bodies()).toEqual([]);
    expect(pages).toEqual([
      { site: 'autonomy_acted_unwritten', facts: { reason: 'model_failed' }, ref: actionId },
    ]);
    expect(await messageRows(parent.familyId)).toEqual([]);
  });

  it('policy off: the same unwritten text pages no one, as before', async () => {
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'calendar_add');
    await recordActed(parent.familyId, 'calendar_add', { payload: { title: 'swim' } });
    const { sendPorts, pages } = ports(async () => ({ skipped: 'model_failed' }));

    const result = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(result.composeSkipped).toBe(1);
    expect(pages).toEqual([]);
  });

  it('policy on: a turn-on text alone is not a tell-after, so its failure pages no one', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'calendar_add');
    const { sendPorts, pages } = ports(async () => ({ skipped: 'model_failed' }));

    const result = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );

    expect(result.composeSkipped).toBe(1);
    expect(pages).toEqual([]);
  });

  it('policy on: an action run as just do owes no text; off, it is owed again', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'add_to_digest_only');
    await recordActed(parent.familyId, 'add_to_digest_only', {
      payload: { title: 'picture day' },
      askTier: 'just_do',
    });
    const { sendPorts, seen } = ports(async (input) => ({
      message: `model ${input.occasion} ${households}`,
    }));

    const on = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(on.justDo).toBe(1);
    expect(on.sent).toBe(1);
    expect(seen.map((row) => row.occasion)).toEqual(['armed']);
    expect(seen[0]?.items).toBeUndefined();

    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const off = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(off.justDo).toBe(0);
    expect(off.sent).toBe(1);
    expect(seen.map((row) => row.occasion)).toEqual(['armed', 'acted']);
  });

  it('policy on: a turn-on text for an ask-first kind is withheld; off, it is owed again', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'send_email');
    const { sendPorts, transport } = ports(async (input) => ({
      message: `model ${input.occasion} ${households}`,
    }));

    const on = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(on.askFirstWithheld).toBe(1);
    expect(on.open).toBe(0);
    expect(on.sent).toBe(0);
    expect(transport.bodies()).toEqual([]);

    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'false');
    const off = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(off.askFirstWithheld).toBe(0);
    expect(off.sent).toBe(1);
  });

  it('policy on: a turn-on text for a tell-after kind still goes', async () => {
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', 'true');
    const parent = await seedParent();
    await grant(parent.familyId, parent.parentUserId, 'calendar_add');
    const { sendPorts } = ports(async (input) => ({
      message: `model ${input.occasion} ${households}`,
    }));

    const result = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, familyId: parent.familyId, slot: 'now' },
      sendPorts,
    );
    expect(result.askFirstWithheld).toBe(0);
    expect(result.sent).toBe(1);
  });

  it('reads the policy per family: a PostHog rollout to one family withholds only its turn-on', async () => {
    const salt = 'vil-719-test-salt';
    vi.stubEnv('POSTHOG_FLAGS_ENABLED', 'true');
    vi.stubEnv(POSTHOG_ID_SALT_ENV, salt);
    // Unset, not `false`: on the PostHog path an env `false` is the kill.
    vi.stubEnv('ASK_POLICY_TIERS_ENABLED', undefined);
    const rolledOut = await seedParent();
    const other = await seedParent();
    await grant(rolledOut.familyId, rolledOut.parentUserId, 'send_email');
    await grant(other.familyId, other.parentUserId, 'send_email');
    const rolledOutId = hashFamilyIdForFlags(rolledOut.familyId, salt);
    setFlagEvaluatorForTests(({ key, distinctId }) =>
      key === 'ask-policy-tiers' ? distinctId === rolledOutId : undefined,
    );
    const { sendPorts } = ports(async (input) => ({
      message: `model ${input.occasion} ${households}`,
    }));

    const result = await dispatchAutonomyNotices(
      db.database,
      { now: MORNING, slot: 'now' },
      sendPorts,
    );

    expect(result.askFirstWithheld).toBe(1);
    expect(result.sent).toBe(1);
    expect(await auditDedupeKeys(rolledOut.familyId, 'autonomy_armed_notice_sent')).toEqual([]);
    expect(await auditDedupeKeys(other.familyId, 'autonomy_armed_notice_sent')).toHaveLength(1);
  });
});
