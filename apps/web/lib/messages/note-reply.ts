import { NOTE_KEY_RE } from '~/lib/coach/note-key';
import type { MessageView } from '~/lib/messages/mappers';

/**
 * The POST /api/coach payload for a reply to one Hale note — the same shape the
 * mobile thread sends, built here so the round trip through that route is unit-
 * tested rather than assembled inline in a client component.
 *
 * `noteKey` is the note's own id: `/api/coach` resolves-or-creates ONE conversation
 * per (family, note), so every reply to a note continues the same thread and no
 * client-held conversation id has to survive a reload.
 *
 * `sourceNote` is the note view the parent is looking at — which the loader has
 * ALREADY redacted. The server never re-fetches the note's content, so this is the
 * only way the answer can be grounded in what the parent actually sees, and it can
 * never carry more than that (rule #1).
 */

/** The route's own cap on the seeded note body (`sourceNote.body`, zod `.max`). An
 * unclamped brief longer than this is a 400 — i.e. the reply would silently fail on
 * exactly the longest notes — so the builder bounds it here. */
export const SOURCE_NOTE_BODY_MAX = 4000;

export interface NoteReplyRequest {
  question: string;
  noteKey: string;
  sourceNote: { eyebrow: string; body: string; when: string };
}

/**
 * Whether this note takes a reply at all.
 *
 * A teen-redacted note does not (rule #1): its body is the placeholder, so a reply
 * would either ground the agent in nothing or invite the parent to ask around a
 * withholding the product just made — mobile refuses the composer on the same
 * branch. And a note whose id is not a note anchor cannot be replied to either: the
 * route rejects it with a 400, so offering a composer would be offering a dead one.
 */
export function canReplyToNote(note: MessageView): boolean {
  return note.teenRedacted !== true && NOTE_KEY_RE.test(note.id);
}

export function noteReplyRequest(note: MessageView, question: string): NoteReplyRequest {
  return {
    question: question.trim(),
    noteKey: note.id,
    sourceNote: {
      eyebrow: note.eyebrow,
      body: note.body.slice(0, SOURCE_NOTE_BODY_MAX),
      when: note.when,
    },
  };
}
