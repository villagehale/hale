/**
 * The initials shown in an avatar when there is no photo. A name plus a second part (a
 * child's last name) yields two upper-cased letters; a name alone yields one; nothing
 * shows a neutral placeholder. Kept pure so the fallback is unit-tested and shared by
 * every avatar surface (parent + child). Never throws.
 */

function firstLetter(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim();
  return trimmed ? trimmed[0].toUpperCase() : '';
}

export function avatarInitials(
  name: string | null | undefined,
  secondary?: string | null,
): string {
  const first = firstLetter(name);
  const second = firstLetter(secondary);
  if (first && second) return `${first}${second}`;
  return first || second || '?';
}
