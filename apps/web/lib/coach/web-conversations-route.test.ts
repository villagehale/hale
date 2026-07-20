import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from './history';

/**
 * The web Ask session rail's two read routes:
 *  - GET /api/coach/conversations         → { conversations } (rail refresh after a send)
 *  - GET /api/coach/conversations/:id      → { conversationId, turns } (reopen a session)
 *
 * Auth() is the 401 gate; the loaders own the DB + rule-#1 family scope (covered in
 * history.test), so they are stubbed here and createDb is poisoned to prove the
 * routes never reach the database themselves. An id that resolves to null (unknown
 * or another family's) is a 404 — indistinguishable, so a foreign thread never leaks.
 */
const authMock = vi.fn();
const loadConversationsMock = vi.fn();
const loadTranscriptMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/coach/history', () => ({
  loadConversations: () => loadConversationsMock(),
  loadConversationTranscript: (id: string) => loadTranscriptMock(id),
}));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('web conversations routes must NOT touch the database directly (rule #1)');
    },
  };
});

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

const VALID_ID = '33333333-3333-4333-8333-333333333333';

const SUMMARIES: ConversationSummary[] = [
  {
    id: VALID_ID,
    title: 'Book the 15-month well-baby visit',
    noteKey: null,
    lastMessageAt: '2026-07-19T17:12:00.000Z',
    messageCount: 4,
  },
];

async function callList(): Promise<Response> {
  const { GET } = await import('~/app/api/coach/conversations/route');
  return GET();
}

async function callTranscript(id: string): Promise<Response> {
  const { GET } = await import('~/app/api/coach/conversations/[id]/route');
  return GET(new Request('http://localhost'), { params: Promise.resolve({ id }) });
}

describe('GET /api/coach/conversations', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadConversationsMock.mockReset();
  });

  it('returns 401 and never lists when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callList();
    expect(res.status).toBe(401);
    expect(loadConversationsMock).not.toHaveBeenCalled();
  });

  it('wraps the loader summaries as { conversations } for a signed-in caller', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadConversationsMock.mockResolvedValue(SUMMARIES);
    const res = await callList();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: SUMMARIES });
  });
});

describe('GET /api/coach/conversations/:id', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadTranscriptMock.mockReset();
  });

  it('returns 401 and never reads when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callTranscript(VALID_ID);
    expect(res.status).toBe(401);
    expect(loadTranscriptMock).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id with 400 before reading', async () => {
    authMock.mockResolvedValue(session('google-1'));
    const res = await callTranscript('not-a-uuid');
    expect(res.status).toBe(400);
    expect(loadTranscriptMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the transcript resolves to null (unknown or foreign)', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadTranscriptMock.mockResolvedValue(null);
    const res = await callTranscript(VALID_ID);
    expect(res.status).toBe(404);
  });

  it('returns { conversationId, turns } for the family’s own thread', async () => {
    authMock.mockResolvedValue(session('google-1'));
    const turns = [
      { id: 'm1', role: 'user', content: 'hi', childId: null, topic: null, createdAt: 'x' },
    ];
    loadTranscriptMock.mockResolvedValue(turns);
    const res = await callTranscript(VALID_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: VALID_ID, turns });
  });
});
