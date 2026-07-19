/** A Hale note id (`digest-<uuid>` / `action-<uuid>`) — the anchor a reply threads
 * its coach conversation to. Format-bounded so it can only ever be a note id, never
 * free text. Shared by the /api/coach POST (which sets the thread) and the
 * /api/mobile/note-thread GET (which replays it), so both bound noteKey identically. */
export const NOTE_KEY_RE =
  /^(digest|action)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
