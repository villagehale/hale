import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OutboundGatePorts, assertProactiveSendAllowed } from '~/lib/channel/outbound-gate';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  clearCollisionHold,
  holdSender,
  isSenderHeld,
  releaseErasedHolds,
  releaseHeldMessage,
} from './opt-out-hold';

const WEBHOOK = 'https://hooks.slack.test/ops';

/** Slack, faked at the webhook fetch: what #ops would have read. */
function stubWebhook(): string[] {
  const posted: string[] = [];
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', WEBHOOK);
  vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === WEBHOOK) posted.push(JSON.parse(init?.body ?? '{}').text);
    return new Response('ok', { status: 200 });
  });
  return posted;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#868 failed-read hold', () => {
  // PGlite's first boot under the full CI suite has crossed the 5s test timeout.
  it('VIL-553: holds a number while any of its unread messages stands', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    expect(await isSenderHeld(db, 'hash-a')).toBe(false);
    expect(await holdSender(db, { phoneHash: 'hash-a', providerMessageId: 'pm-1', now })).toBe(
      'held',
    );
    expect(await holdSender(db, { phoneHash: 'hash-a', providerMessageId: 'pm-1', now })).toBe(
      'already_held',
    );
    await holdSender(db, { phoneHash: 'hash-a', providerMessageId: 'pm-2', now });
    expect(await isSenderHeld(db, 'hash-a')).toBe(true);
    expect(await isSenderHeld(db, 'hash-b')).toBe(false);

    expect(await releaseHeldMessage(db, 'pm-1')).toBe('released');
    expect(await isSenderHeld(db, 'hash-a')).toBe(true);
    expect(await releaseHeldMessage(db, 'pm-x')).toBe('not_held');
    expect(await releaseHeldMessage(db, 'pm-2')).toBe('released');
    expect(await isSenderHeld(db, 'hash-a')).toBe(false);
    expect(await isSenderHeld(db, 'hash-b')).toBe(false);
  }, 30_000);

  it('a row written before VIL-553 still holds its number', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    await db.insert(schema.optOutReadHolds).values({ phoneHash: 'hash-c', heldAt: now });
    await holdSender(db, { phoneHash: 'hash-c', providerMessageId: 'pm-3', now });
    await releaseHeldMessage(db, 'pm-3');
    expect(await isSenderHeld(db, 'hash-c')).toBe(true);
    expect(await isSenderHeld(db, 'hash-d')).toBe(false);
  }, 30_000);

  it('one provider id on two numbers holds both, pages #ops, and names the collision', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    const posted = stubWebhook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await holdSender(db, { phoneHash: 'hash-one', providerMessageId: 'pm-shared', now });

    // Positive control: the same number replaying its own id is a replay, and pages nobody.
    expect(
      await holdSender(db, { phoneHash: 'hash-one', providerMessageId: 'pm-shared', now }),
    ).toBe('already_held');
    expect(await db.select().from(schema.optOutReadHolds)).toEqual([]);
    expect(posted).toEqual([]);

    expect(
      await holdSender(db, { phoneHash: 'hash-two', providerMessageId: 'pm-shared', now }),
    ).toBe('held_id_collision');
    expect(await isSenderHeld(db, 'hash-one')).toBe(true);
    expect(await isSenderHeld(db, 'hash-two')).toBe(true);
    // The second number is held by a row of its own that no store can place, never by a
    // legacy per-number row a later text of that number would retire.
    const held = await db
      .select({
        id: schema.optOutHeldMessages.providerMessageId,
        phoneHash: schema.optOutHeldMessages.phoneHash,
      })
      .from(schema.optOutHeldMessages);
    expect(held.map((row) => row.phoneHash).sort()).toEqual(['hash-one', 'hash-two']);
    const collisionKey = held.find((row) => row.phoneHash === 'hash-two')?.id;
    expect(collisionKey).toEqual(expect.any(String));
    // The row says what it is in a column of its own, never only by the shape of its key.
    const kinds = await db
      .select({
        phoneHash: schema.optOutHeldMessages.phoneHash,
        kind: schema.optOutHeldMessages.kind,
      })
      .from(schema.optOutHeldMessages);
    expect(kinds.sort((a, b) => a.phoneHash.localeCompare(b.phoneHash))).toEqual([
      { phoneHash: 'hash-one', kind: 'message' },
      { phoneHash: 'hash-two', kind: 'id_collision' },
    ]);
    expect(collisionKey).not.toBe('pm-shared');
    // The key names no number: the blind index is the row's own column, never its key.
    expect(collisionKey).not.toContain('hash-two');
    expect(await db.select().from(schema.optOutReadHolds)).toEqual([]);
    // Replaying the second number's text holds nothing new and pages nobody again.
    expect(
      await holdSender(db, { phoneHash: 'hash-two', providerMessageId: 'pm-shared', now }),
    ).toBe('already_held');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('opt_out_hold_id_collision');
    expect(posted[0]).not.toContain('hash-two');
    expect(posted[0]).not.toContain('pm-shared');
    // A third number on the same id is not the second number's replay: it is held by its own row.
    expect(await isSenderHeld(db, 'hash-three')).toBe(false);
    expect(
      await holdSender(db, { phoneHash: 'hash-three', providerMessageId: 'pm-shared', now }),
    ).toBe('held_id_collision');
    expect(await isSenderHeld(db, 'hash-three')).toBe(true);
    const third = await db
      .select({ id: schema.optOutHeldMessages.providerMessageId })
      .from(schema.optOutHeldMessages)
      .where(eq(schema.optOutHeldMessages.phoneHash, 'hash-three'));
    expect(third).toHaveLength(1);
    expect(third[0]?.id).not.toBe(collisionKey);
    // The first number's read still releases only its own row.
    expect(await releaseHeldMessage(db, 'pm-shared')).toBe('released');
    expect(await isSenderHeld(db, 'hash-one')).toBe(false);
    expect(await isSenderHeld(db, 'hash-two')).toBe(true);
    // The replay kept the same one row: the key is determined by the pair, so a second
    // insert cannot leave another hold for the operator to miss.
    const two = await db
      .select({ id: schema.optOutHeldMessages.providerMessageId })
      .from(schema.optOutHeldMessages)
      .where(eq(schema.optOutHeldMessages.phoneHash, 'hash-two'));
    expect(two).toHaveLength(1);
    expect(two[0]?.id).toBe(collisionKey);
  }, 30_000);

  it('two deliveries of one colliding text hold that number once', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    const posted = stubWebhook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await holdSender(db, { phoneHash: 'hash-one', providerMessageId: 'pm-shared', now });

    const outcomes = await Promise.all([
      holdSender(db, { phoneHash: 'hash-two', providerMessageId: 'pm-shared', now }),
      holdSender(db, { phoneHash: 'hash-two', providerMessageId: 'pm-shared', now }),
    ]);
    expect(outcomes.sort()).toEqual(['already_held', 'held_id_collision']);
    const two = await db
      .select({ id: schema.optOutHeldMessages.providerMessageId })
      .from(schema.optOutHeldMessages)
      .where(eq(schema.optOutHeldMessages.phoneHash, 'hash-two'));
    expect(two).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('opt_out_hold_id_collision');
  }, 30_000);

  it('only the operator path clears a collision hold, and it writes the holder an audit row', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    stubWebhook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const phone = '+15555550102';
    const holder = await seedFamily(db, 'Held Family');
    await db.insert(schema.parentChannels).values({
      userId: holder.parentUserId,
      familyId: holder.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(phone),
      phoneE164Hash: phoneBlindIndex(phone),
      verifiedAt: now,
    });
    await holdSender(db, { phoneHash: 'hash-one', providerMessageId: 'pm-shared', now });
    await holdSender(db, {
      phoneHash: phoneBlindIndex(phone),
      providerMessageId: 'pm-shared',
      now,
    });
    const [collision] = await db
      .select({ id: schema.optOutHeldMessages.providerMessageId })
      .from(schema.optOutHeldMessages)
      .where(eq(schema.optOutHeldMessages.phoneHash, phoneBlindIndex(phone)));
    const key = collision?.id as string;

    // No read releases it, and no erasure of a number someone still holds does.
    expect(await releaseHeldMessage(db, key)).toBe('not_held');
    await releaseErasedHolds(db, {
      phoneHashes: [phoneBlindIndex(phone)],
      providerMessageIds: [key],
      undecodableNumbers: [],
      undecodableSessions: 0,
    });
    expect(await isSenderHeld(db, phoneBlindIndex(phone))).toBe(true);
    // The operator path never takes a message hold: those go only when their text is read.
    expect(await clearCollisionHold(db, 'pm-shared')).toBe('not_a_collision_hold');
    expect(await isSenderHeld(db, 'hash-one')).toBe(true);

    expect(await clearCollisionHold(db, key)).toBe('cleared');
    expect(await isSenderHeld(db, phoneBlindIndex(phone))).toBe(false);
    expect(await clearCollisionHold(db, key)).toBe('not_a_collision_hold');
    const audit = await db
      .select({
        familyId: schema.auditLog.familyId,
        action: schema.auditLog.actionTaken,
        targetTable: schema.auditLog.targetTable,
        targetId: schema.auditLog.targetId,
      })
      .from(schema.auditLog);
    expect(audit).toEqual([
      {
        familyId: holder.familyId,
        action: 'opt_out_hold_cleared',
        targetTable: 'users',
        targetId: holder.parentUserId,
      },
    ]);
  }, 30_000);

  it('a hold of a kind this code does not know is kept like a collision (fail closed)', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    await db.insert(schema.optOutHeldMessages).values([
      {
        providerMessageId: 'pm-mystery',
        phoneHash: 'hash-m',
        heldAt: now,
        nextReadAt: now,
        kind: 'from_a_later_release',
      },
      { providerMessageId: 'pm-plain', phoneHash: 'hash-p', heldAt: now, nextReadAt: now },
    ]);

    // Positive control: a message hold is released by its read.
    expect(await releaseHeldMessage(db, 'pm-plain')).toBe('released');
    expect(await releaseHeldMessage(db, 'pm-mystery')).toBe('not_held');
    expect(await isSenderHeld(db, 'hash-m')).toBe(true);
    expect(await clearCollisionHold(db, 'pm-mystery')).toBe('cleared');
    expect(await isSenderHeld(db, 'hash-m')).toBe(false);
  }, 30_000);

  it('the outbound gate holds every proactive kind, urgent or not, while held', async () => {
    const ports: OutboundGatePorts = {
      channelEnrolled: async () => true,
      watchConsentGranted: async () => true,
      countProactiveSends: async () => 0,
      proactiveSentSince: async () => false,
      parentTimeZone: async () => 'America/Toronto',
      optOutUnread: async () => true,
    };
    const request = {
      familyId: 'f',
      parentUserId: 'p',
      kind: 'spot_open_instant' as const,
      now: new Date('2026-10-14T16:00:00Z'),
      urgent: true,
    };
    expect(await assertProactiveSendAllowed(request, ports)).toEqual({
      allowed: false,
      reason: 'opt_out_unread',
    });
    expect(
      (await assertProactiveSendAllowed(request, { ...ports, optOutUnread: async () => false }))
        .allowed,
    ).toBe(true);
  });
});
