import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationSummary } from './history';

/**
 * GET /api/mobile/conversations — the Ask-session list route's auth boundary +
 * envelope wiring. Auth() is the 401 gate; a signed-in caller gets the loader's
 * family-scoped summaries wrapped as { conversations }. The loader owns the DB +
 * rule-#1 family scope (covered in history.test), so it is stubbed here — and
 * createDb is poisoned to prove the route never reaches the database itself.
 */
const authMock = vi.fn();
const loadConversationsMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/coach/history', () => ({ loadConversations: () => loadConversationsMock() }));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile conversations route must NOT touch the database directly (rule #1)');
    },
  };
});

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/conversations/route');
  return GET();
}

const SUMMARIES: ConversationSummary[] = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'What does this nap-regression brief mean…',
    noteKey: 'action-abc',
    lastMessageAt: '2026-06-17T11:06:00.000Z',
    messageCount: 2,
  },
];

describe('GET /api/mobile/conversations — auth gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadConversationsMock.mockReset();
  });

  it('returns 401 and never lists when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadConversationsMock).not.toHaveBeenCalled();
  });

  it('returns the loader summaries wrapped as { conversations } for a signed-in caller', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadConversationsMock.mockResolvedValue(SUMMARIES);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: SUMMARIES });
  });
});
