import type { Database } from '@hale/db';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';

/**
 * Hale texted this parent something they did not ask for — put it in the thread.
 *
 * The parent's next message is read against `messages`, and only against `messages`:
 * `channel_messages` deliberately stores `body: null` (rule #1), so a send that skips
 * this call is a sentence the coach can never see the parent answering. Across prod on
 * 2026-08-22, 11 of 71 post-account SMS outbounds (15%) were in exactly that state —
 * two health nudges, six village intros, a weekly plan and a voice callback — and the
 * founder-visible symptom was Hale re-proposing a thing it had already offered, because
 * from where it sits it never offered it.
 *
 * RESOLVE-OR-CREATE, never `if (conversationId)`. The senders that already thread do it
 * behind a null check on a conversation id they carried in from a ledger row, which is
 * the silent-no-op shape hard rule #11 exists to forbid: a family whose first-ever text
 * is a nudge has no thread yet, and the branch quietly drops Hale's opening line. The
 * thread is derivable from (familyId, parentUserId) alone — the same note anchor C1
 * resolves on an inbound — so there is nothing to be absent, and no absence to handle.
 *
 * THE COMPOSED SENTENCE, NOT THE WIRE BODY. Callers pass what they wrote, before
 * `withOptOut` and before any share link: the CASL footer belongs on the wire and
 * nowhere else, and this row is both what the parent reads back in the app and what the
 * coach re-reads next turn (the rule sweep.ts and plan/check-in.ts already keep).
 *
 * Recorded as `assistant` because that is who said it. Redaction is the caller's, and
 * already done: every body reaching here has been through its own composer's gates, and
 * a teen-redacted send stays redacted in the thread because it is the same string.
 */
export async function threadProactiveMessage(
  database: Database,
  input: { familyId: string; parentUserId: string; body: string },
): Promise<string> {
  const conversationId = await resolveOrCreateNoteConversation(
    input.familyId,
    channelSmsNoteKey(input.parentUserId),
    database,
  );
  await appendMessage(conversationId, 'assistant', input.body, database);
  return conversationId;
}
