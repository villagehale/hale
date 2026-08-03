'use server';

import { NOTE_KEY_RE } from '~/lib/coach/note-key';
import { loadNoteThread, type NoteThread } from '~/lib/messages/note-thread';

/**
 * The web `/messages` seam onto a note's reply transcript. The note list selects in
 * the browser, so the thread loads per-note on demand; this is a thin passthrough
 * over the SAME loader `/api/mobile/note-thread` calls (the push-prefs precedent —
 * auth, family scope and the credential-less degradation stay in the lib, in exactly
 * one place, rather than being re-implemented per surface).
 *
 * The key is bounded to a real note anchor BEFORE the loader runs — the same
 * NOTE_KEY_RE that route and the /api/coach POST enforce — so a client-supplied
 * string can only ever resolve a note id, never free text and never the SMS thread
 * namespace (rule #1).
 */
export async function loadNoteThreadAction(noteKey: string): Promise<NoteThread> {
  if (!NOTE_KEY_RE.test(noteKey)) return { conversationId: null, turns: [] };
  return loadNoteThread(noteKey);
}
