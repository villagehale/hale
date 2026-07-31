/** A Hale note id (`digest-<uuid>` / `action-<uuid>`) — the anchor a reply threads
 * its coach conversation to. Format-bounded so it can only ever be a note id, never
 * free text. Shared by the /api/coach POST (which sets the thread) and the
 * /api/mobile/note-thread GET (which replays it), so both bound noteKey identically. */
export const NOTE_KEY_RE =
  /^(digest|action)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * VIL-220 · C1 — the second namespace in this column: the ONE long-lived thread a
 * parent's texts append to.
 *
 * It reuses the note anchor wholesale rather than adding a column, which buys the
 * partial unique index on (family_id, note_key) as the concurrency guard: two texts
 * arriving together resolve to the same conversation instead of forking a parent's
 * history into two threads.
 *
 * Scoped per PARENT, not per family. Two parents in one household hold two channels and
 * two phones; merging their texts into one thread would show each of them the other's
 * messages, which is a disclosure neither consented to (rule #1). The family scope is
 * still enforced by the index — the key only has to separate people inside it.
 *
 * The colon is load-bearing: it makes these keys structurally unable to satisfy
 * NOTE_KEY_RE, which is the bound /api/coach puts on a CLIENT-supplied noteKey. So a
 * browser cannot address this thread by key at all — only the router writes it.
 */
const CHANNEL_SMS_NOTE_KEY_PREFIX = 'channel-sms:';

export function channelSmsNoteKey(parentUserId: string): string {
  return `${CHANNEL_SMS_NOTE_KEY_PREFIX}${parentUserId}`;
}

export function isChannelSmsNoteKey(noteKey: string | null): boolean {
  return noteKey?.startsWith(CHANNEL_SMS_NOTE_KEY_PREFIX) ?? false;
}

/**
 * What the Ask history calls this thread. A text thread runs for months, so its first
 * user turn ("hi") is an accident of when the parent started rather than a subject —
 * the namespace is the honest name, and it stays stable as the thread grows.
 */
export const CHANNEL_SMS_THREAD_TITLE = 'Texts with Hale';
