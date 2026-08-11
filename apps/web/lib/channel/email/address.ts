/**
 * The `From` header, reduced to the one thing the rest of the leg may act on: a single
 * routable address. This is the email twin of `normalizePhoneE164` — an address we
 * cannot canonicalize is an address we cannot hash, look up, or answer, so it is
 * dropped rather than guessed at.
 *
 * THE DISPLAY NAME IS NOT EVIDENCE. `"billing@bank.test" <attacker@evil.test>` is a
 * well-formed header whose display name is a lie the sender chose. Only the
 * angle-bracket address is the sender, and it is what this returns; the display name
 * comes back separately so a caller can render it but never route on it.
 *
 * NOT CANONICALIZED BEYOND CASE. Lowercasing is safe (no mainstream provider treats
 * mailboxes case-sensitively, and `users.email` is compared case-insensitively
 * elsewhere in the app). Gmail's dot-folding and `+tag` stripping are NOT applied: they
 * are provider-specific, and applying them universally would collapse two genuinely
 * different mailboxes at another provider into one identity — which, on a lookup that
 * resolves a family, is a cross-family disclosure rather than a tidy-up.
 */

export interface ParsedAddress {
  /** The routable address, lowercased. */
  address: string;
  /** The domain half, lowercased — what DKIM alignment is checked against. */
  domain: string;
  displayName: string | null;
}

/**
 * A single address: a local part with no whitespace, `@`, and a dotted domain. Kept
 * deliberately stricter than RFC 5322 (which permits quoted local parts, comments, and
 * bare hostnames): everything this rejects is something no parent's mail client sends,
 * and each permitted exotic form is another shape the identity lookup would have to be
 * correct about.
 */
const ADDRESS = /^[^\s<>@,"]+@[^\s<>@,".]+(?:\.[^\s<>@,".]+)+$/;

const ANGLE_FORM = /^(.*)<([^<>]*)>\s*$/;

function unquote(displayName: string): string | null {
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  const quoted = /^"(.*)"$/.exec(trimmed);
  return (quoted ? quoted[1] : trimmed)?.trim() || null;
}

/** The sender behind a `From` header value, or null when it is not one routable
 * address. Never throws — a malformed header is a message we drop, not a crash. */
export function parseEmailAddress(header: string): ParsedAddress | null {
  const trimmed = header.trim();
  if (!trimmed) return null;

  const angled = ANGLE_FORM.exec(trimmed);
  const raw = (angled ? angled[2] : trimmed)?.trim() ?? '';
  if (!ADDRESS.test(raw)) return null;

  const address = raw.toLowerCase();
  return {
    address,
    domain: domainOf(address),
    displayName: angled?.[1] ? unquote(angled[1]) : null,
  };
}

/** The domain half of an address, lowercased, or empty string when there isn't one. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase();
}
