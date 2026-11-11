import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';

/**
 * VIL-662 · email content is untrusted (VIL-615 / VIL-560 / VIL-628).
 *
 * Only time, place and team leave this module. A field that holds a link or a
 * phone number is dropped whole, not patched: a redacted fragment is still a
 * path for a number or a host to ride a parent text.
 */

export interface TrustedScheduleFacts {
  team: string | null;
  place: string | null;
}

/** Digit run long enough to be a phone once separators are gone. Not a word list. */
function holdsPhone(text: string): boolean {
  return text.replace(/\D/g, '').length >= 10;
}

function trustedField(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return null;
  if (hasLinkShape(trimmed) || holdsPhone(trimmed)) return null;
  const unlinked = withoutLinks(trimmed).trim();
  if (unlinked === '') return null;
  return unlinked;
}

export function scrubScheduleFacts(input: {
  title?: string | null;
  location?: string | null;
  address?: string | null;
}): TrustedScheduleFacts {
  const place = trustedField(input.location) ?? trustedField(input.address);
  return {
    team: trustedField(input.title),
    place,
  };
}
