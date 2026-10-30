import { normalizePhoneE164 } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';

/**
 * Per-plan identity for one person in the chat.
 *
 * A seated or known phone uses the blind index so a STOP or a later message
 * from the same handle updates the same row. Someone Hale has only as a name
 * (a non-customer who never shared a number Hale stored) uses a folded name.
 * The two namespaces cannot collide: hashes are hex, name keys are prefixed.
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
