import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OutboundGatePorts, assertProactiveSendAllowed } from '~/lib/channel/outbound-gate';
import { createTestDb } from '~/lib/testing/pglite';
import { holdSender, isSenderHeld, releaseHeldMessage } from './opt-out-hold';

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
    // The second number is held per number, beside the first number's row.
    expect(await db.select().from(schema.optOutReadHolds)).toEqual([
      { phoneHash: 'hash-two', heldAt: now, repointedAt: null },
    ]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('held_id_collision');
    expect(posted[0]).not.toContain('hash-two');
    expect(posted[0]).not.toContain('pm-shared');
    // The first number's read still releases only its own row.
    expect(await releaseHeldMessage(db, 'pm-shared')).toBe('released');
    expect(await isSenderHeld(db, 'hash-one')).toBe(false);
    expect(await isSenderHeld(db, 'hash-two')).toBe(true);
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
