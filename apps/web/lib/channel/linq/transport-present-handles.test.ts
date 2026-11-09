import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLinqParticipantHandles, readLinqChatHandles } from './transport';

const CHAT = '3b0c4f1e-6a2d-4c8e-9f17-5d2a7e9b1c40';
const API_KEY = 'linq_test_key_not_a_secret';

const HALE = '+15555550100';
const ACTIVE = '+15555550101';
const NANNY_EMAIL = 'nanny@example.com';
const REMOVED = '+15555550103';
const LEFT = '+15555550104';
const NULL_STATUS = '+15555550105';
const NO_STATUS = '+15555550106';
const ACTIVE_BUT_LEFT_AT = '+15555550107';
const NULL_STATUS_LEFT_AT = '+15555550108';
const NO_STATUS_LEFT_AT = '+15555550109';

/** GET /v3/chats/{id} as Linq documents it: departed people stay listed. A person who
 * left and was added back can carry a stale left_at beside a present status. */
const DOCS_CHAT = {
  chat: {
    id: CHAT,
    is_group: true,
    handles: [
      { id: 'h-a', handle: HALE, service: 'iMessage', status: 'active', is_me: true },
      { id: 'h-b', handle: ACTIVE, service: 'iMessage', status: 'active', is_me: false },
      { id: 'h-c', handle: NANNY_EMAIL, service: 'iMessage', status: 'active', is_me: false },
      {
        id: 'h-d',
        handle: REMOVED,
        service: 'iMessage',
        status: 'removed',
        left_at: '2026-10-30T15:00:00Z',
        is_me: false,
      },
      { id: 'h-e', handle: LEFT, service: 'iMessage', status: 'left', is_me: false },
      { id: 'h-f', handle: NULL_STATUS, service: 'iMessage', status: null, is_me: false },
      { id: 'h-g', handle: NO_STATUS, service: 'iMessage', is_me: false },
      {
        id: 'h-h',
        handle: ACTIVE_BUT_LEFT_AT,
        service: 'iMessage',
        status: 'active',
        left_at: '2026-10-31T09:00:00Z',
        is_me: false,
      },
      {
        id: 'h-i',
        handle: NULL_STATUS_LEFT_AT,
        service: 'iMessage',
        status: null,
        left_at: '2026-10-31T09:00:00Z',
        is_me: false,
      },
      {
        id: 'h-j',
        handle: NO_STATUS_LEFT_AT,
        service: 'iMessage',
        left_at: '2026-10-31T09:00:00Z',
        is_me: false,
      },
    ],
  },
};

const PRESENT = [
  ACTIVE,
  NANNY_EMAIL,
  NULL_STATUS,
  NO_STATUS,
  ACTIVE_BUT_LEFT_AT,
  NULL_STATUS_LEFT_AT,
  NO_STATUS_LEFT_AT,
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readLinqChatHandles: present participants only', () => {
  it('drops Hale and only an explicit left or removed status; left_at alone removes no one', () => {
    expect(readLinqChatHandles(DOCS_CHAT)).toEqual(PRESENT);
  });
});

describe('listLinqParticipantHandles: the GET returns present handles only', () => {
  it('reads the docs-shaped payload through the real request', async () => {
    vi.stubEnv('LINQ_API_KEY', API_KEY);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(DOCS_CHAT, { status: 200 }),
    );
    expect(await listLinqParticipantHandles({ chatId: CHAT, fetch: fetchMock })).toEqual({
      status: 'ok',
      handles: PRESENT,
      isGroup: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });
});
