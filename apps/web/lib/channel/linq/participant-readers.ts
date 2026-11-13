import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import type { ListChatHandles } from './roster';

export type ParticipantRead = Awaited<ReturnType<ListChatHandles>>;

/** Who Linq lists in a chat now, as blind indexes. */
export interface ChatReaders {
  /** Everyone Linq lists in the chat now. */
  hashes: readonly string[];
  /**
   * Of them, the ones Linq says joined no later than the message was sent, on Linq's own
   * clock. Anyone whose join time Linq does not give, or gives as after the send, is left out,
   * and so is everyone when the message carried no sent time.
   */
  presentAtSend: ReadonlySet<string>;
}

/**
 * VIL-687: the blind indexes of everyone Linq lists in a chat, for deciding who may see a
 * hidden gift, or null when the list does not place everyone: a failed read, a chat Linq
 * says is not a group, a list without the speaker (an empty one included, which is what a
 * 200 with no or unreadable body parses to), or a handle that is not a number (an Apple ID
 * email). Linq's list already leaves out people who left or were removed
 * (readLinqChatHandles); Hale's own line is not a reader. It only ever narrows who sees a
 * secret; it never lets anything be sent.
 */
export function listedReaders(
  listed: ParticipantRead | null,
  speakerHash: string,
  isHaleLine: (phone: string) => boolean,
  sentAt: Date | null,
): ChatReaders | null {
  if (listed?.status !== 'ok' || listed.isGroup === false) return null;
  const hashes = new Set<string>();
  // A number listed twice (two spellings) counts as present only if every listing does.
  const notYet = new Set<string>();
  for (const handle of listed.handles) {
    const phone = normalizePhoneE164(handle);
    if (phone === null) return null;
    if (isHaleLine(phone)) continue;
    const hash = phoneBlindIndex(phone);
    hashes.add(hash);
    const joined = listed.joinedAt?.get(handle);
    if (!sentAt || !joined || joined > sentAt) notYet.add(hash);
  }
  if (!hashes.has(speakerHash)) return null;
  return {
    hashes: [...hashes],
    presentAtSend: new Set([...hashes].filter((hash) => !notYet.has(hash))),
  };
}
