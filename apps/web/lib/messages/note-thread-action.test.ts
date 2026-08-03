import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web seam onto the note transcript. `/messages` selects a note in the browser,
 * so the thread has to load per-note on demand; this action is the passthrough that
 * lets it, over the SAME loader the mobile route calls (the push-prefs precedent —
 * auth, family scope and degradation live in the lib, in one place).
 *
 * What is the action's own to get right: it must bound the key to a real note anchor
 * BEFORE the loader runs — the same NOTE_KEY_RE bound /api/mobile/note-thread and the
 * /api/coach POST enforce — so a client-supplied string can only ever resolve a note
 * id, never free text (rule #1).
 */

const loadNoteThreadMock = vi.fn();
vi.mock('~/lib/messages/note-thread', () => ({
  loadNoteThread: (...a: unknown[]) => loadNoteThreadMock(...a),
}));

const NOTE_KEY = 'digest-11111111-1111-4111-8111-111111111111';

async function call(noteKey: string) {
  const { loadNoteThreadAction } = await import('./note-thread-action');
  return loadNoteThreadAction(noteKey);
}

describe('loadNoteThreadAction', () => {
  beforeEach(() => {
    vi.resetModules();
    loadNoteThreadMock.mockReset();
  });

  it('returns the loader thread verbatim for a real note anchor', async () => {
    const thread = {
      conversationId: 'conv-1',
      turns: [
        { role: 'user' as const, content: 'what should I do about that?' },
        { role: 'assistant' as const, content: 'shorter naps usually settle in a fortnight.' },
      ],
    };
    loadNoteThreadMock.mockResolvedValue(thread);

    await expect(call(NOTE_KEY)).resolves.toEqual(thread);
    expect(loadNoteThreadMock).toHaveBeenCalledWith(NOTE_KEY);
  });

  it('refuses a key that is not a note anchor — the loader never runs', async () => {
    await expect(call('channel-sms:user-1')).resolves.toEqual({
      conversationId: null,
      turns: [],
    });
    expect(loadNoteThreadMock).not.toHaveBeenCalled();
  });

  it('refuses an empty key without querying', async () => {
    await expect(call('')).resolves.toEqual({ conversationId: null, turns: [] });
    expect(loadNoteThreadMock).not.toHaveBeenCalled();
  });
});
