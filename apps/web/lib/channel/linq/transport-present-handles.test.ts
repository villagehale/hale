import { afterEach, describe, expect, it, vi } from 'vitest';
import { listLinqParticipantHandles, readLinqChatHandles, readLinqChatJoinedAt } from './transport';

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

describe('readLinqChatHandles: a present participant it cannot read is not dropped', () => {
  it('returns an unplaceable handle for a present record without a readable handle', () => {
    const chat = {
      chat: {
        is_group: true,
        handles: [
          { handle: ACTIVE, status: 'active' },
          { handle: null, status: 'active' },
          { status: 'active' },
          { handle: 42 },
          'not-a-record',
          { handle: null, status: 'left' },
          { handle: null, is_me: true },
        ],
      },
    };
    expect(readLinqChatHandles(chat)).toEqual([ACTIVE, '', '', '', '']);
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
      joinedAt: new Map(PRESENT.map((handle) => [handle, null])),
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
  });
});

describe('readLinqChatJoinedAt: when Linq says each present participant joined', () => {
  const JOINED = '2026-11-20T15:00:00.000Z';
  const BEFORE = '2026-11-20T14:00:00.000Z';
  const AFTER = '2026-11-20T16:00:00.000Z';
  const at = (iso: string) => new Date(iso);
  const joins = (handles: unknown[]) => readLinqChatJoinedAt({ chat: { handles } });

  it('gives the join time of a present record that never left, or left before it joined', () => {
    expect(
      joins([
        { handle: ACTIVE, status: 'active', joined_at: JOINED, left_at: null },
        { handle: NULL_STATUS, joined_at: JOINED, left_at: BEFORE },
      ]),
    ).toEqual(
      new Map([
        [ACTIVE, at(JOINED)],
        [NULL_STATUS, at(JOINED)],
      ]),
    );
  });

  it('cannot say for a record with no join time, a leave at or after it, or a leave it cannot read', () => {
    expect(
      joins([
        { handle: ACTIVE, status: 'active' },
        { handle: NULL_STATUS, status: 'active', joined_at: JOINED, left_at: AFTER },
        { handle: NO_STATUS, status: 'active', joined_at: JOINED, left_at: JOINED },
        { handle: ACTIVE_BUT_LEFT_AT, status: 'active', joined_at: JOINED, left_at: 'soon' },
        { handle: NULL_STATUS_LEFT_AT, status: 'active', joined_at: 'not a time' },
      ]),
    ).toEqual(
      new Map([
        [ACTIVE, null],
        [NULL_STATUS, null],
        [NO_STATUS, null],
        [ACTIVE_BUT_LEFT_AT, null],
        [NULL_STATUS_LEFT_AT, null],
      ]),
    );
  });

  it('leaves out Hale and anyone listed as left or removed', () => {
    expect(
      joins([
        { handle: HALE, is_me: true, joined_at: JOINED },
        { handle: REMOVED, status: 'removed', joined_at: BEFORE, left_at: JOINED },
        { handle: LEFT, status: 'left', joined_at: BEFORE },
      ]),
    ).toEqual(new Map());
  });

  it('a handle listed twice gives the later time, or none if either record cannot say', () => {
    expect(
      joins([
        { handle: ACTIVE, status: 'active', joined_at: BEFORE },
        { handle: ACTIVE, status: 'active', joined_at: JOINED },
        { handle: NULL_STATUS, status: 'active', joined_at: JOINED },
        { handle: NULL_STATUS, status: 'active' },
        { handle: NO_STATUS, status: 'active', joined_at: JOINED },
        { handle: NO_STATUS, status: 'active', joined_at: BEFORE },
        { handle: ACTIVE_BUT_LEFT_AT, status: 'active' },
        { handle: ACTIVE_BUT_LEFT_AT, status: 'active', joined_at: JOINED },
      ]),
    ).toEqual(
      new Map([
        [ACTIVE, at(JOINED)],
        [NULL_STATUS, null],
        [NO_STATUS, at(JOINED)],
        [ACTIVE_BUT_LEFT_AT, null],
      ]),
    );
  });
});
