import { describe, expect, it } from 'vitest';
import { type OutboundGatePorts, assertProactiveSendAllowed } from '~/lib/channel/outbound-gate';
import { createTestDb } from '~/lib/testing/pglite';
import { holdSender, isSenderHeld, releaseSender } from './opt-out-hold';

describe('#868 failed-read hold', () => {
  it('holds a sender until a read succeeds', async () => {
    const db = (await createTestDb()).database;
    const now = new Date('2026-10-14T20:00:00Z');
    expect(await isSenderHeld(db, 'hash-a')).toBe(false);
    await holdSender(db, 'hash-a', now);
    await holdSender(db, 'hash-a', now);
    expect(await isSenderHeld(db, 'hash-a')).toBe(true);
    expect(await isSenderHeld(db, 'hash-b')).toBe(false);
    await releaseSender(db, 'hash-a');
    expect(await isSenderHeld(db, 'hash-a')).toBe(false);
  });

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
