import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSpokenLineBody, fakeSpokenLineComposer } from '~/lib/channel/voice/fakes';
import { acknowledgeDutyWrite, dutyQuietHours } from './ack';
import { COPARENT_DUTY_COPY_LOCKED_ENV } from './copy';
import { COPARENT_DUTY_MEMORY_ENABLED_ENV } from './flag';
import { dutyLineInput } from './line-input';

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
    expect(tap.urls()).toEqual(['https://api.linqapp.com/api/partner/v3/messages/msg-1/reactions']);
    expect(tap.bodies()[0]).toContain('"type":"like"');
    expect(tap.urls().join('\n')).not.toContain(`/chats/${CHAT}/messages`);

    const rest = http();
    const voice = fakeSpokenLineComposer();
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
      voice,
      fetch: rest.fetch,
    });
    expect(restated.status).toBe('restated');
    expect(restated.sent).toBe(true);
    // The restate is the model's (VIL-413 / VIL-417): the owner kind, confirming back
    // what Hale just wrote down, from exactly these facts.
    const request = {
      kind: 'owner' as const,
      owner: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      recorded: true,
    };
    expect(voice.calls.map((call) => call.input)).toEqual([dutyLineInput(request, 'en')]);
    expect(restated.text).toBe(fakeSpokenLineBody(dutyLineInput(request, 'en')));
    expect(restated.text).not.toContain('Say so here if that changes.');
    expect(rest.urls()[0]).toContain(`/chats/${CHAT}/messages`);
    expect(rest.bodies().join('\n')).not.toMatch(/reply stop|unsubscribe/i);
  });

  it('sends no restate when the lane is dark, when a fact is missing, or when the model cannot write it', async () => {
    vi.stubEnv(COPARENT_DUTY_MEMORY_ENABLED_ENV, 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const wire = http();
    const base = {
      database: ledgerDb(),
      familyId: FAMILY,
      actorUserId: ACTOR,
      source: 'llm' as const,
      now: DAY,
      timeZone: 'America/Toronto',
      inboundChatId: CHAT,
      inboundMessageId: 'msg-3',
      language: 'en' as const,
      name: 'Barton',
      kid: 'Maya',
      event: 'swim',
      day: 'Saturday',
      time: '3:00pm',
      fetch: wire.fetch,
    };
    // Dark lane: no model call is made.
    const dark = fakeSpokenLineComposer();
    expect(await acknowledgeDutyWrite({ ...base, voice: dark })).toMatchObject({
      status: 'skipped',
      reason: 'copy_locked',
    });
    expect(dark.calls).toEqual([]);

    vi.stubEnv(COPARENT_DUTY_COPY_LOCKED_ENV, 'true');
    const idle = fakeSpokenLineComposer();
    expect(await acknowledgeDutyWrite({ ...base, kid: null, voice: idle })).toMatchObject({
      status: 'skipped',
      reason: 'no_facts',
    });
    expect(idle.calls).toEqual([]);

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = fakeSpokenLineComposer({ fail: true });
    expect(await acknowledgeDutyWrite({ ...base, voice: failing })).toMatchObject({
      status: 'skipped',
      reason: 'voice_unsent',
      sent: false,
      text: null,
    });
    error.mockRestore();
    // Full prompt, then the short retry; then nothing - no template stood in.
    expect(failing.calls.map((call) => call.prompt)).toEqual(['full', 'short']);
    expect(wire.urls()).toEqual([]);
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
