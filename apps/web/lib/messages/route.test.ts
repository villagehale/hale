import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageView } from './mappers';

/**
 * GET /api/mobile/messages — the route's auth boundary + envelope wiring. Auth() is
 * the 401 gate; a signed-in caller gets the loader's redacted feed wrapped as
 * { messages }. The loader owns the DB + rule-#1 redaction (covered in
 * queries.test), so it's stubbed here — this test asserts the route never leaks the
 * feed to an unauthenticated caller.
 */

const authMock = vi.fn();
const loadMessagesMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/messages/queries', () => ({ loadMessages: () => loadMessagesMock() }));

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/messages/route');
  return GET();
}

const FEED: MessageView[] = [
  {
    id: 'action-a1',
    kind: 'action',
    eyebrow: 'Reply to email',
    body: 'Hale drafted "Reply to email" for your yes.',
    when: 'Jun 20, 06:00',
    actionState: 'drafted_for_approval',
    teenRedacted: false,
  },
];

describe('GET /api/mobile/messages — auth gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadMessagesMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 and never reads the feed when the caller is not signed in', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadMessagesMock).not.toHaveBeenCalled();
  });

  it('returns the loader feed wrapped as { messages } for a signed-in caller', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadMessagesMock.mockResolvedValue(FEED);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: FEED });
  });
});
