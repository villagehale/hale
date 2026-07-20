import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineMessage } from './conversation';

/**
 * GET /api/mobile/conversations/:id — the reopen route. Validates the id shape,
 * gates on auth (401), then delegates to loadConversationTranscript, which resolves
 * the family and verifies ownership (rule #1). A null result — the conversation is
 * unknown or belongs to another family, indistinguishable — becomes a 404 that never
 * reveals a foreign thread's existence. createDb is poisoned to prove the route
 * never reaches the DB itself (the loader does, behind currentFamilyId).
 */
const authMock = vi.fn();
const loadTranscriptMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/coach/history', () => ({
  loadConversationTranscript: (id: string) => loadTranscriptMock(id),
}));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile conversation transcript route must NOT touch the database directly (rule #1)');
    },
  };
});

const CONV_ID = '33333333-3333-4333-8333-333333333333';
const TURNS: TimelineMessage[] = [
  { id: 'm0', role: 'user', content: 'when do I start solids?', childId: null, topic: 'feeding', createdAt: '2026-06-17T10:00:00.000Z' },
  { id: 'm1', role: 'assistant', content: 'around six months.', childId: null, topic: 'feeding', createdAt: '2026-06-17T10:01:00.000Z' },
];

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

async function callGet(id: string): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/conversations/[id]/route');
  return GET(new Request(`http://localhost/api/mobile/conversations/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/mobile/conversations/:id', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadTranscriptMock.mockReset();
    loadTranscriptMock.mockResolvedValue(TURNS);
  });

  it('rejects a non-uuid id with 400 and never authenticates or reads', async () => {
    const res = await callGet('not-a-uuid');

    expect(res.status).toBe(400);
    expect(authMock).not.toHaveBeenCalled();
    expect(loadTranscriptMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never reads the transcript', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet(CONV_ID);

    expect(res.status).toBe(401);
    expect(loadTranscriptMock).not.toHaveBeenCalled();
  });

  it('returns { conversationId, turns } for a signed-in parent', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callGet(CONV_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: CONV_ID, turns: TURNS });
    expect(loadTranscriptMock).toHaveBeenCalledWith(CONV_ID);
  });

  it('returns 404 when the conversation is unknown or belongs to another family', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadTranscriptMock.mockResolvedValue(null);

    const res = await callGet('44444444-4444-4444-8444-444444444444');

    expect(res.status).toBe(404);
  });
});
