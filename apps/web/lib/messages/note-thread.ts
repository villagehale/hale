import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import {
  loadTranscript,
  resolveNoteConversation,
  type TranscriptMessage,
} from '~/lib/coach/conversation';

/**
 * The prior reply exchange for one Hale note — the transcript the mobile thread
 * replays when it re-opens so a re-visit shows history. Mirrors loadMessages: the
 * route never touches the DB, this loader owns the query building and family scope.
 *
 * Family-scoped (rule #1): the note conversation is resolved by the caller's OWN
 * family + noteKey. This NEVER re-fetches the note's content — only the reply
 * transcript (parent replies + Hale's answers, which never hold raw note or teen
 * content) is returned. Degrades to an empty thread in the credential-less preview,
 * when no family resolves, and before the first reply opens the note's thread.
 */
export interface NoteThread {
  conversationId: string | null;
  turns: TranscriptMessage[];
}

export function loadNoteThread(noteKey: string): Promise<NoteThread> {
  if (!process.env.DATABASE_URL) {
    return Promise.resolve({ conversationId: null, turns: [] });
  }
  const database = defaultDb();
  return currentFamilyId(database).then(async (familyId) => {
    if (!familyId) {
      return { conversationId: null, turns: [] };
    }
    const conversationId = await resolveNoteConversation(familyId, noteKey, database);
    const turns = conversationId ? await loadTranscript(conversationId, database) : [];
    return { conversationId, turns };
  });
}
