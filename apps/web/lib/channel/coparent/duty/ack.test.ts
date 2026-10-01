import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeDutyWrite, dutyQuietHours } from './ack';
import { COPARENT_DUTY_COPY_LOCKED_ENV } from './copy';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from './flag';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';

function ledgerDb(): Database {
  const returning = vi.fn().mockResolvedValue([{ id: 'ledger-1' }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { insert, update } as unknown as Database;
}

const CHAT = 'chat-parent-started';
const DAY = new Date('2026-09-24T15:00:00.000Z');
const QUIET = new Date('2026-09-25T01:30:00.000Z');

afterEach(() => {
  vi.unstubAllEnvs();
});

function http(): { fetch: typeof fetch; urls: () => string[]; bodies: () => string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(String(url));
    if (init?.body) bodies.push(String(init.body));
    return new Response(JSON.stringify({ message: { id: 'msg-out' } }), { status: 201 });
  });
  return {
    fetch: fetchMock as unknown as typeof fetch,
    urls: () => urls,
    bodies: () => bodies,
  };
}

describe('acknowledgeDutyWrite', () => {
  it('holds quiet hours and refuses a chat Hale would have to open', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    expect(dutyQuietHours(QUIET, 'America/Toronto')).toBe(true);
    expect(dutyQuietHours(DAY, 'America/Toronto')).toBe(false);
    const wire = http();
    const held = await acknowledgeDutyWrite({
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'rules',
      now: QUIET,
      timeZone: 'America/Toronto',
      inboundChatId: CHAT,
      inboundMessageId: 'msg-1',
      language: 'en',
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      fetch: wire.fetch,
    });
    expect(held).toEqual({ status: 'held', reason: 'quiet_hours', sent: false, text: null });
    const unsolicited = await acknowledgeDutyWrite({
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'llm',
      now: DAY,
      timeZone: 'America/Toronto',
      inboundChatId: null,
      inboundMessageId: null,
      language: 'en',
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      fetch: wire.fetch,
    });
    expect(unsolicited).toMatchObject({
      status: 'skipped',
      reason: 'no_proactive_1to1',
      sent: false,
    });
    expect(wire.urls()).toEqual([]);
  });

  it('tapbacks a deterministic hit and restates an llm hit in one next-step line', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const tap = http();
    const tapped = await acknowledgeDutyWrite({
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'rules',
      now: DAY,
      timeZone: 'America/Toronto',
      inboundChatId: CHAT,
      inboundMessageId: 'msg-1',
      language: 'en',
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      fetch: tap.fetch,
    });
    expect(tapped).toEqual({ status: 'tapback', sent: false, text: null });
    expect(tap.urls()).toEqual([
      'https://api.linqapp.com/api/partner/v3/messages/msg-1/reactions',
    ]);
    expect(tap.bodies()[0]).toContain('"type":"like"');
    expect(tap.urls().join('\n')).not.toContain(`/chats/${CHAT}/messages`);

    const rest = http();
    const restated = await acknowledgeDutyWrite({
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'llm',
      now: DAY,
      timeZone: 'America/Toronto',
      inboundChatId: CHAT,
      inboundMessageId: 'msg-2',
      language: 'en',
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      fetch: rest.fetch,
    });
    expect(restated.status).toBe('restated');
    expect(restated.sent).toBe(true);
    expect(restated.text).toBe(
      "Barton has Maya's swim, Saturday at 3:00pm. Say so here if that changes.",
    );
    expect(rest.urls()[0]).toContain(`/chats/${CHAT}/messages`);
    expect(rest.bodies().join('\n')).not.toMatch(/reply stop|unsubscribe/i);
  });

  it('does not speak a non-kid title', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const wire = http();
    const skipped = await acknowledgeDutyWrite({
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'llm',
      now: DAY,
      timeZone: 'America/Toronto',
      inboundChatId: CHAT,
      inboundMessageId: 'msg-1',
      language: 'en',
      name: 'Barton',
      kid: 'Maya',
      event: 'Quarterly board review',
      day: 'Saturday',
      time: '3:00pm',
      fetch: wire.fetch,
    });
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'non_kid_title', sent: false });
    expect(wire.urls()).toEqual([]);
  });
});
