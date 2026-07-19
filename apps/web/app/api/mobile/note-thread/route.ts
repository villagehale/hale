import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { NOTE_KEY_RE } from '~/lib/coach/note-key';
import { loadNoteThread } from '~/lib/messages/note-thread';
import type { MobileNoteThreadResponse } from '../types';

export const runtime = 'nodejs';

/**
 * GET /api/mobile/note-thread?noteKey=… — the prior reply exchange for one Hale
 * note, replayed when a mobile thread re-opens so a re-visit shows history. Returns
 * the note's coach transcript (the parent's replies + Hale's answers), or an empty
 * thread until the first reply opens it.
 *
 * This route never touches the DB (rule #1): loadNoteThread resolves the family and
 * owns the query building, and NEVER re-fetches the note's content — the note itself
 * is the app's already-redacted view; only the reply transcript (which never holds
 * raw note / teen content) is returned here. Auth() is the 401 gate.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const noteKey = new URL(req.url).searchParams.get('noteKey');
  // Bound the key to a real note id before the loader runs — the SAME NOTE_KEY_RE the
  // /api/coach POST enforces when it sets the thread, so a re-open can only ever
  // resolve a well-formed note id, never free text.
  if (!noteKey || !NOTE_KEY_RE.test(noteKey)) {
    return NextResponse.json({ error: 'missing_note_key' }, { status: 400 });
  }

  const body: MobileNoteThreadResponse = await loadNoteThread(noteKey);
  return NextResponse.json(body);
}
