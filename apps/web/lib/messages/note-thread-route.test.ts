import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/mobile/note-thread — the re-open seam a mobile thread hits to replay a
 * note's prior reply exchange. We stub auth + the loader edges so the test exercises
 * the route's gating (401 unauthenticated, 400 without a note key) and that a valid
 * call delegates to loadNoteThread and returns its shape verbatim. The loader owns
 * the family-scoped query building (tested separately); this asserts the route wiring.
 */
const authMock = vi.fn();
const loadNoteThreadMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/messages/note-thread', () => ({
  loadNoteThread: (...a: unknown[]) => loadNoteThreadMock(...a),
}));

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callGet(url: string) {
  const { GET } = await import('~/app/api/mobile/note-thread/route');
  return GET(new Request(url));
}

const NOTE_KEY = 'action-44444444-4444-4444-8444-444444444444';

describe('GET /api/mobile/note-thread', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadNoteThreadMock.mockReset();
  });

  it('returns 401 when the caller is not signed in (never reads a thread)', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet(`http://localhost/api/mobile/note-thread?noteKey=${NOTE_KEY}`);

    expect(res.status).toBe(401);
    expect(loadNoteThreadMock).not.toHaveBeenCalled();
  });

  it('returns 400 when no noteKey is supplied', async () => {
    authMock.mockResolvedValue(session('google-1'));

    const res = await callGet('http://localhost/api/mobile/note-thread');

    expect(res.status).toBe(400);
    expect(loadNoteThreadMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed noteKey (same NOTE_KEY_RE the POST path enforces)', async () => {
    authMock.mockResolvedValue(session('google-1'));

    // A note key can only ever be `digest-<uuid>` / `action-<uuid>`; free text must
    // be rejected before the loader runs, mirroring the /api/coach POST bound.
    const res = await callGet('http://localhost/api/mobile/note-thread?noteKey=not-a-note-key');

    expect(res.status).toBe(400);
    expect(loadNoteThreadMock).not.toHaveBeenCalled();
  });

  it('delegates to loadNoteThread and returns its transcript for the note', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadNoteThreadMock.mockResolvedValue({
      conversationId: 'conv-note-1',
      turns: [
        { role: 'user', content: 'what should I do about the nap regression?' },
        { role: 'assistant', content: 'here is what that brief means for your week.' },
      ],
    });

    const res = await callGet(`http://localhost/api/mobile/note-thread?noteKey=${NOTE_KEY}`);

    expect(res.status).toBe(200);
    expect(loadNoteThreadMock).toHaveBeenCalledWith(NOTE_KEY);
    expect(await res.json()).toEqual({
      conversationId: 'conv-note-1',
      turns: [
        { role: 'user', content: 'what should I do about the nap regression?' },
        { role: 'assistant', content: 'here is what that brief means for your week.' },
      ],
    });
  });

  it('returns the empty-thread shape before the first reply opens it', async () => {
    authMock.mockResolvedValue(session('google-1'));
    loadNoteThreadMock.mockResolvedValue({ conversationId: null, turns: [] });

    const res = await callGet(`http://localhost/api/mobile/note-thread?noteKey=${NOTE_KEY}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: null, turns: [] });
  });
});
