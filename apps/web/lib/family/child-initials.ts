/**
 * A child's monogram for the avatar fallback: the first-name initial plus the
 * last-name initial when a last name is present, or the first-name initial alone
 * otherwise. Uppercased; falls back to a neutral placeholder for an empty name.
 *
 * Blended-family safety (rule #1): the last initial can come ONLY from the child's
 * own stored `lastName` — the signature carries no parent/family surname, so a child
 * logged first-name-only can never have a second letter borrowed from a parent.
 */
export function childInitials(name: string, lastName?: string | null): string {
  const first = firstGrapheme(name);
  const last = lastName ? firstGrapheme(lastName) : '';
  const initials = `${first}${last}`.toUpperCase();
  return initials.length > 0 ? initials : '?';
}

/** The first code point of a trimmed string (spread avoids splitting a surrogate
 * pair, so an emoji or astral glyph stays whole), or '' when the string is empty. */
function firstGrapheme(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  return [...trimmed][0] ?? '';
}
