import { normalizePhoneE164 } from '~/lib/channels/phone';
import { linqHandleBlindIndex, phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * Per-plan identity for one person in the chat.
 *
 * A seated or known phone uses the blind index so a STOP or a later message
 * from the same handle updates the same row. Someone Hale has only as a name
 * (a non-customer who never shared a number Hale stored) uses a folded name.
 * A handle that is neither a phone nor named (an Apple-ID address) uses its own
 * keyed index, never the handle in plaintext. The namespaces cannot collide:
 * phone hashes are bare hex, the other two are prefixed.
 */

export function nameKey(displayName: string): string {
  return `name:${displayName.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export function phoneMemberKey(phoneE164: string): string {
  return phoneBlindIndex(phoneE164);
}

export function memberKeyFromHandle(handle: string): string | null {
  const phone = normalizePhoneE164(handle);
  return phone ? phoneMemberKey(phone) : null;
}

export function memberKeyFromName(displayName: string): string {
  return nameKey(displayName);
}

function handleMemberKey(handle: string): string {
  return `handle:${linqHandleBlindIndex(handle.trim().toLowerCase())}`;
}

/**
 * The key one sender's answers are written under. A nameless non-phone handle was
 * once keyed `name:<handle>`, so that legacy key is read too: when only it is on a
 * live plan or poll, the sender keeps answering on that row instead of starting a
 * second one. `knownKeys` is read only for such a sender.
 */
export async function senderMemberKey(
  sender: { handle: string; name: string | null | undefined },
  knownKeys: () => Promise<readonly string[]>,
): Promise<string> {
  const phone = memberKeyFromHandle(sender.handle);
  if (phone) return phone;
  const name = sender.name?.trim();
  if (name) return nameKey(name);
  const key = handleMemberKey(sender.handle);
  const legacy = nameKey(sender.handle);
  const known = new Set(await knownKeys());
  return !known.has(key) && known.has(legacy) ? legacy : key;
}
