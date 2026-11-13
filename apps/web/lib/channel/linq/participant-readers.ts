import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import type { ListChatHandles } from './roster';

export type ParticipantRead = Awaited<ReturnType<ListChatHandles>>;

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
): string[] | null {
  if (listed?.status !== 'ok' || listed.isGroup === false) return null;
  const hashes = new Set<string>();
  for (const handle of listed.handles) {
    const phone = normalizePhoneE164(handle);
    if (phone === null) return null;
    if (isHaleLine(phone)) continue;
    hashes.add(phoneBlindIndex(phone));
  }
  return hashes.has(speakerHash) ? [...hashes] : null;
}
